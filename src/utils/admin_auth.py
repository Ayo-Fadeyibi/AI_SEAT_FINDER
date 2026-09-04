"""
Shared admin-auth helpers: password hashing and the user store.

Used by both the API server (login + session validation) and
scripts/create_admin.py (bootstrapping/resetting the shared admin
credential). There is no public signup endpoint — provisioning an admin
account requires shell access to run the CLI script.
"""

import hashlib
import hmac
import secrets


def load_users() -> list[dict]:
    """Admin accounts from the database (was data/admin_users.json)."""
    from api.repository import load_users as _load_users
    return _load_users()


def save_users(users: list[dict]):
    """Replace the whole admin-user set in the database."""
    from api.repository import save_users as _save_users
    _save_users(users)


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    """PBKDF2-HMAC-SHA256. Returns (salt_hex, hash_hex)."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000)
    return salt.hex(), digest.hex()


def verify_password(password: str, salt_hex: str, hash_hex: str) -> bool:
    _, digest_hex = hash_password(password, bytes.fromhex(salt_hex))
    return hmac.compare_digest(digest_hex, hash_hex)
