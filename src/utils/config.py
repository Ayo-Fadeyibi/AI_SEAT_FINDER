"""
Application configuration with encrypted API key management.

The API key is stored using base64 encoding + XOR obfuscation.
In production, use proper secrets management (e.g., vault, env vars).
"""

import base64
import os
from pathlib import Path

# ── XOR salt for basic obfuscation (not real encryption) ──────────────
_SALT = b"FindaSpot2024!@#"

# ── Encoded API key (XOR + base64 obfuscation) ───────────────────────
# Use env var FINDASPOT_API_KEY to override in production
ENCODED_KEY = "MhlDBwMpAB4XWlpGUll0Ti4CBwYZOEQFHAVRWllJM0krXl1WFjYJA0RLXwYMEiRELwRc"


def _decode_key() -> str:
    """Decode the obfuscated API key."""
    # Allow environment variable override
    env_key = os.environ.get("FINDASPOT_API_KEY")
    if env_key:
        return env_key
    raw = base64.b64decode(ENCODED_KEY)
    return bytes(b ^ _SALT[i % len(_SALT)] for i, b in enumerate(raw)).decode()


# ── LLM Configuration ────────────────────────────────────────────────
# Xiaomi MiMo Token Plan (OpenAI-compatible)
LLM_API_KEY = _decode_key()
LLM_BASE_URL = os.environ.get(
    "FINDASPOT_LLM_BASE_URL",
    "https://token-plan-cn.xiaomimimo.com/v1",
)
LLM_MODEL = os.environ.get(
    "FINDASPOT_LLM_MODEL",
    "mimo-v2.5",
)

# ── Paths ────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"
