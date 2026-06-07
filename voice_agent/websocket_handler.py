"""
websocket_handler.py — Twilio Media Stream WebSocket handler.

Twilio sends a sequence of JSON messages over the WebSocket:
  1. {"event": "connected", ...}
  2. {"event": "start", "start": {"callSid": "...", "streamSid": "..."}}
  3. {"event": "media", "media": {"payload": "<base64 mulaw>", "track": "inbound"}}
  4. {"event": "stop", ...}

Key design decisions:
  - BOT_SPEAKING_HOLD_FRAMES: After TTS is sent, inbound audio is MUTED
    for this many frames (each = 20ms). Twilio echoes outbound audio back
    as inbound media, which causes an infinite response loop without this.
  - Pipeline runs in a background THREAD so new audio frames are never dropped.
  - A threading.Event prevents two pipeline invocations from running at once.
"""

import base64
import json
import logging
import threading
import time

import numpy as np

from voice_agent.audio_utils import (
    mulaw_b64_to_pcm16k,
    is_silence,
    SILENCE_FRAMES_END,
    WHISPER_SAMPLE_RATE,
)
from voice_agent import stt_module, tts_module
from voice_agent.response_engine import get_or_create_session, end_session
from voice_agent import call_logger

logger = logging.getLogger(__name__)

# Minimum speech duration before we attempt STT
MIN_UTTERANCE_SECS    = 0.5
MIN_UTTERANCE_SAMPLES = int(MIN_UTTERANCE_SECS * WHISPER_SAMPLE_RATE)

# After sending TTS audio, mute inbound for this many 20ms frames.
# Twilio echoes outbound audio back as "inbound" — without this mute window
# the agent transcribes its own voice and creates an infinite reply loop.
# Rule of thumb: (TTS duration in seconds / 0.02) + 25 buffer frames.
# We use a dynamic mute calculated from actual audio length sent.
BOT_BASE_MUTE_FRAMES = 30   # minimum mute after any TTS send (~600ms)

# Protect WebSocket sends from concurrent threads
_ws_lock = threading.Lock()

# Pre-encoded µ-law silence: 160 bytes of 0xFF = 20 ms at 8 kHz.
# Sent periodically while the LLM is thinking to prevent Twilio from
# closing the WebSocket due to inactivity (Twilio times out ~30s of silence).
_MULAW_SILENCE_B64: str = base64.b64encode(bytes([0xFF] * 160)).decode()


def handle_media_stream(ws) -> None:
    """Main WebSocket handler — called by Flask-Sock for each /media-stream connection."""
    call_sid: str  = "unknown"
    stream_sid: str = ""

    audio_buffer: list[np.ndarray] = []
    silence_count: int = 0

    pipeline_busy = threading.Event()   # set while STT+TTS is running
    mute_until_frame: list[int] = [0]   # frame index below which inbound is muted
    frame_count: list[int] = [0]        # total inbound frames seen

    logger.info("[WS] New WebSocket connection opened.")

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break

            data = json.loads(raw)
            event = data.get("event", "")

            # ── connected ────────────────────────────────────────────────────
            if event == "connected":
                logger.info("[WS] Twilio connected: protocol=%s", data.get("protocol"))

            # ── start ────────────────────────────────────────────────────────
            elif event == "start":
                start_info = data.get("start", {})
                call_sid   = start_info.get("callSid", "unknown")
                stream_sid = start_info.get("streamSid", "")
                logger.info("[WS] Stream started | call=%s | stream=%s", call_sid, stream_sid)
                get_or_create_session(call_sid)
                call_logger.start_log(call_sid)

                # Send greeting in background (so we start receiving audio right away)
                threading.Thread(
                    target=_send_tts,
                    args=(ws, stream_sid,
                          "Welcome! What would you like to order today?",
                          "en", mute_until_frame, frame_count, call_sid),
                    daemon=True,
                ).start()

            # ── media ────────────────────────────────────────────────────────
            elif event == "media":
                media = data.get("media", {})
                if media.get("track", "") != "inbound":
                    continue

                payload = media.get("payload", "")
                frame_count[0] += 1

                # ── MUTE WINDOW: discard audio while AI is speaking ───────
                if frame_count[0] <= mute_until_frame[0]:
                    # Still in mute window — reset buffer so stale audio doesn't
                    # accumulate during playback
                    audio_buffer = []
                    silence_count = 0
                    continue

                raw_mulaw = base64.b64decode(payload)

                # VAD
                if is_silence(raw_mulaw):
                    silence_count += 1
                else:
                    silence_count = 0

                pcm_chunk = mulaw_b64_to_pcm16k(payload)
                audio_buffer.append(pcm_chunk)

                # End of utterance: silence detected + pipeline not busy
                if (silence_count >= SILENCE_FRAMES_END
                        and len(audio_buffer) > 0
                        and not pipeline_busy.is_set()):

                    total_samples = sum(len(c) for c in audio_buffer)
                    if total_samples >= MIN_UTTERANCE_SAMPLES:
                        utterance = list(audio_buffer)
                        audio_buffer = []
                        silence_count = 0
                        pipeline_busy.set()

                        threading.Thread(
                            target=_process_utterance,
                            args=(ws, stream_sid, call_sid, utterance,
                                  pipeline_busy, mute_until_frame, frame_count),
                            daemon=True,
                        ).start()
                    else:
                        audio_buffer = []
                        silence_count = 0

            # ── stop ─────────────────────────────────────────────────────────
            elif event == "stop":
                logger.info("[WS] Stream stopped for call %s", call_sid)
                end_session(call_sid)
                call_logger.end_log(call_sid)
                break

    except Exception as exc:
        logger.error("[WS] Error: %s", exc, exc_info=True)
    finally:
        logger.info("[WS] Connection closed for call %s", call_sid)


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _keepalive_silence(ws, stream_sid: str, stop_event: threading.Event) -> None:
    """Send µ-law silence frames every second so Twilio doesn't time out the
    WebSocket while the LLM / chatbot is thinking.  Stops when stop_event fires."""
    msg = json.dumps({
        "event":     "media",
        "streamSid": stream_sid,
        "media":     {"payload": _MULAW_SILENCE_B64},
    })
    while not stop_event.wait(1.0):   # send once per second
        with _ws_lock:
            try:
                ws.send(msg)
            except Exception:
                break   # WebSocket already closed — exit quietly


def _process_utterance(ws, stream_sid: str, call_sid: str,
                        audio_chunks: list[np.ndarray],
                        done_event: threading.Event,
                        mute_until_frame: list[int],
                        frame_count: list[int]) -> None:
    """STT → response → TTS pipeline running in background thread."""
    try:
        pcm_audio = np.concatenate(audio_chunks)
        dur = round(len(pcm_audio) / WHISPER_SAMPLE_RATE, 2)
        print(f"[Pipeline] Audio received from Twilio — {dur:.2f}s for call {call_sid}")
        logger.info("[Pipeline] Processing %.2fs of audio for call %s", dur, call_sid)

        # STT
        stt_result = stt_module.transcribe(pcm_audio)
        text       = stt_result.get("text", "").strip()
        language   = stt_result.get("language", "en")
        confidence = stt_result.get("confidence", 0.0)

        if not text:
            logger.info("[Pipeline] STT empty — skipping.")
            return

        print(f"[Pipeline] STT result: {text!r}  (lang={language}, conf={confidence:.2f})")
        logger.info("[Pipeline] STT → lang=%s  text=%r", language, text[:80])

        # Response — keepalive silence keeps the Twilio WS open while LLM thinks
        print(f"[Pipeline] Sending to chatbot: {text!r}")
        session = get_or_create_session(call_sid, language)
        _ka_stop = threading.Event()
        threading.Thread(
            target=_keepalive_silence,
            args=(ws, stream_sid, _ka_stop),
            daemon=True,
        ).start()
        try:
            response_text = session.process(text, language)
        finally:
            _ka_stop.set()   # stop keepalive regardless of success/failure
        print(f"[Pipeline] Chatbot reply: {response_text!r}")
        logger.info("[Pipeline] Response → %r", response_text[:80])

        # Log user turn
        detected_items = [i for i in session.ordered_items]
        clog = call_logger.get_log(call_sid)
        if clog:
            clog.log_user(text, language, confidence, items=detected_items)

        # TTS + send
        print(f"[Pipeline] Sending audio response to Twilio")
        _send_tts(ws, stream_sid, response_text, language, mute_until_frame, frame_count, call_sid)

    except Exception as exc:
        logger.error("[Pipeline] Error: %s", exc, exc_info=True)
    finally:
        done_event.clear()


def _send_tts(ws, stream_sid: str, text: str, language: str,
              mute_until_frame: list[int], frame_count: list[int],
              call_sid: str = "") -> None:
    """Synthesise TTS, send to Twilio, and set the mute window."""
    mulaw_b64 = tts_module.synthesize(text, language=language)
    if not mulaw_b64:
        logger.warning("[Pipeline] TTS empty — skipping send.")
        return

    # Each mulaw byte = 1 sample at 8kHz = 0.125ms
    # base64 decode: len(b64) * 3/4 bytes → / 8000 = seconds of audio
    audio_bytes   = len(mulaw_b64) * 3 // 4
    audio_secs    = audio_bytes / 8000.0
    # Add a short buffer: audio duration + 0.5s for Twilio processing
    mute_frames   = int((audio_secs + 0.5) / 0.02) + BOT_BASE_MUTE_FRAMES
    mute_until_frame[0] = frame_count[0] + mute_frames
    logger.info("[Pipeline] TTS %.1fs audio → muting %d frames (until frame %d)",
                audio_secs, mute_frames, mute_until_frame[0])

    message = json.dumps({
        "event":     "media",
        "streamSid": stream_sid,
        "media":     {"payload": mulaw_b64}
    })
    with _ws_lock:
        try:
            ws.send(message)
            logger.info("[Pipeline] Sent TTS to Twilio (%d chars b64)", len(mulaw_b64))
            # Log bot turn
            if call_sid:
                clog = call_logger.get_log(call_sid)
                if clog:
                    clog.log_bot(text, language)
        except Exception as exc:
            logger.error("[Pipeline] Failed to send TTS: %s", exc)
