"""
response_engine.py — Forwarding conversation logic to Petpooja TypeScript Chatbot.

This module replaces the local, rule-based response generation with an
HTTP call to the petpooja chatbot server (http://localhost:3000/chat).
"""

import logging
import os
import time
import requests
from dotenv import load_dotenv

# Load env from the voice_agent directory
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

logger = logging.getLogger(__name__)

# Config
CHATBOT_API_URL = os.getenv("CHATBOT_API_URL", "http://localhost:3000/chat")
CHATBOT_TIMEOUT = float(os.getenv("CHATBOT_TIMEOUT_SECS", "12.0"))
FALLBACK_REPLY = "I'm sorry, I'm having trouble connecting right now. Could you please repeat that?"

# In-memory session store (mapping call_sid -> sessionId)
_SESSIONS: dict[str, "ResponseSession"] = {}


class ResponseSession:
    def __init__(self, call_sid: str):
        self.call_sid = call_sid
        self.turn_count = 0
        self.ordered_items: list[str] = []  # Kept for compatibility with call_logger

    def process(self, text: str, language: str = "en") -> str:
        """Forward user text to the petpooja chatbot API and return the reply."""
        self.turn_count += 1

        payload = {
            "sessionId": self.call_sid,
            "message": text,
        }

        print(f"[Chatbot] ➜  Sending to chatbot ({CHATBOT_API_URL}): {text!r}")
        logger.info("[Response] Forwarding to chatbot: %r (session=%s, turn=%d)",
                    text, self.call_sid, self.turn_count)

        t0 = time.time()
        try:
            response = requests.post(
                CHATBOT_API_URL,
                json=payload,
                timeout=CHATBOT_TIMEOUT,
            )
            elapsed = round(time.time() - t0, 2)

            print(f"[Chatbot] ◀  HTTP {response.status_code} in {elapsed}s — body: {response.text[:300]}")
            logger.info("[Response] HTTP %d in %.2fs — body: %s",
                        response.status_code, elapsed, response.text[:300])

            # Try to extract a reply from the body regardless of status code.
            # voice.routes.ts always returns 200 now, but guard against legacy behavior.
            try:
                data = response.json()
                reply = data.get("reply") or data.get("text") or data.get("message")
                if reply and reply.strip():
                    logger.debug("[Response] Chatbot reply: %r", reply)
                    return reply.strip()
            except ValueError:
                logger.warning("[Response] Chatbot returned non-JSON body (status=%d)", response.status_code)

            if response.status_code != 200:
                logger.error("[Response] Chatbot API non-200 status: %d — using fallback", response.status_code)

            return FALLBACK_REPLY

        except requests.exceptions.ConnectionError as exc:
            elapsed = round(time.time() - t0, 2)
            print(f"[Chatbot] ✗  Connection refused after {elapsed}s — is petpooja server running on port 3000?")
            logger.error("[Response] Connection refused: %s", exc)
            return FALLBACK_REPLY

        except requests.exceptions.Timeout as exc:
            elapsed = round(time.time() - t0, 2)
            print(f"[Chatbot] ✗  Request timed out after {elapsed}s (limit={CHATBOT_TIMEOUT}s)")
            logger.error("[Response] Chatbot request timed out after %.2fs: %s", elapsed, exc)
            return FALLBACK_REPLY

        except requests.exceptions.RequestException as exc:
            elapsed = round(time.time() - t0, 2)
            print(f"[Chatbot] ✗  Request error after {elapsed}s: {exc}")
            logger.error("[Response] Failed to connect to chatbot: %s", exc)
            return FALLBACK_REPLY


def get_or_create_session(call_sid: str, language: str = "en") -> ResponseSession:
    if call_sid not in _SESSIONS:
        _SESSIONS[call_sid] = ResponseSession(call_sid)
    return _SESSIONS[call_sid]


def end_session(call_sid: str) -> None:
    if call_sid in _SESSIONS:
        del _SESSIONS[call_sid]
        logger.info("[Response] Session ended: %s", call_sid)
