#!/usr/bin/env python3
"""
Create or reset the shared admin credential for FindaSpot.

There's no public signup endpoint by design — only whoever has shell
access to the server can provision the admin login. Run this once after
cloning to create the account, or any time you want to reset the password.

Usage:
    python scripts/create_admin.py
"""

import getpass
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.utils.admin_auth import hash_password, load_users, save_users


def main() -> None:
    username = input("Admin username: ").strip()
    if not username:
        print("Username can't be empty.")
        sys.exit(1)

    password = getpass.getpass("Admin password: ")
    if len(password) < 6:
        print("Password must be at least 6 characters.")
        sys.exit(1)
    if password != getpass.getpass("Confirm password: "):
        print("Passwords didn't match.")
        sys.exit(1)

    users = load_users()
    salt_hex, hash_hex = hash_password(password)
    existing = next((u for u in users if u["username"] == username), None)
    if existing:
        existing["salt"] = salt_hex
        existing["password_hash"] = hash_hex
        print(f"Updated password for existing admin '{username}'.")
    else:
        users.append({"username": username, "salt": salt_hex, "password_hash": hash_hex})
        print(f"Created admin account '{username}'.")

    save_users(users)


if __name__ == "__main__":
    main()
