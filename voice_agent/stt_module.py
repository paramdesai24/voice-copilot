"""
stt_module.py — Fast STT wrapper using faster-whisper tiny (pre-loaded).

Key optimisations vs original:
  - Uses faster-whisper "tiny" model (downloads from HuggingFace, 4x faster than "small")
  - Pre-loads the model at module import time (eliminates 5-10s first-call delay)
  - Transcribes in-memory PCM array directly (no temp file write/read overhead)
"""

import logging
import sys
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

# ── Pre-load the Whisper model at import time ─────────────────────────────────
# Using "tiny" for real-time speed (~0.3-0.8s on CPU).
_MODEL_NAME = "tiny"
logger.info("[STT] Loading Whisper %s model (pre-load for low latency)...", _MODEL_NAME)
try:
    _MODEL = WhisperModel(_MODEL_NAME, device="cpu", compute_type="int8")
    logger.info("[STT] Whisper %s ready.", _MODEL_NAME)
except Exception as _e:
    logger.error("[STT] Failed to load Whisper model: %s", _e)
    _MODEL = None


def transcribe(pcm_audio: np.ndarray) -> dict:
    """Transcribe a float32 PCM array (16 kHz) using faster-whisper tiny.

    Args:
        pcm_audio: float32 numpy array of audio samples at 16 kHz.

    Returns:
        dict with keys: text, language, confidence, processing_time
    """
    import time

    if pcm_audio is None or len(pcm_audio) == 0:
        return {"text": "", "language": "unknown", "confidence": 0, "error": "empty audio"}

    if _MODEL is None:
        return {"text": "", "language": "unknown", "confidence": 0, "error": "model not loaded"}

    t0 = time.time()
    try:
        # faster-whisper expects float32 in [-1, 1] at 16 kHz
        segments, info = _MODEL.transcribe(
            pcm_audio,
            language=None,    # auto-detect
            task="transcribe",
            beam_size=1,      # greedy decode — fastest
            best_of=1,
            temperature=0.0,  # deterministic
            vad_filter=True,  # skip silence
        )
        elapsed = time.time() - t0

        # Collect all segment text and confidence
        all_text = []
        total_prob = 0.0
        count = 0
        for seg in segments:
            all_text.append(seg.text)
            total_prob += seg.avg_logprob
            count += 1

        text = " ".join(all_text).strip()
        lang = info.language if info.language else "unknown"
        avg_prob = (total_prob / count) if count else -5

        # Map to our language codes
        lang_map = {"hi": "hi", "en": "en", "gu": "gu", "mr": "mr",
                    "ta": "ta", "te": "te", "kn": "kn", "bn": "bn", "pa": "pa"}
        lang = lang_map.get(lang, lang)

        confidence = round(min(max(2 ** avg_prob, 0.0), 1.0), 2) if avg_prob > -5 else 0.0

        logger.info("[STT] text=%r  lang=%s  conf=%.2f  time=%.2fs",
                    text[:80], lang, confidence, elapsed)

        return {
            "text": text,
            "language": lang,
            "confidence": confidence,
            "processing_time": round(elapsed, 3),
        }

    except Exception as exc:
        logger.error("[STT] Whisper error: %s", exc)
        return {"text": "", "language": "unknown", "confidence": 0, "error": str(exc)}
