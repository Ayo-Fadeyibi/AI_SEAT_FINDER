"""
Database engine + session management for the PostgreSQL-backed store.

Synchronous SQLAlchemy 2.0 (psycopg3 driver). The repository layer
(api/repository.py) is the only module that should import `SessionLocal` /
`session_scope` directly; endpoints get a session via the `get_session`
FastAPI dependency.
"""

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

# ── Connection URL ────────────────────────────────────────────────────
# Defaults to the docker-compose.yml database; override via DATABASE_URL
# (see .env.example). A .env file at the project root is loaded best-effort
# so `python api/server.py` works without exporting the var by hand.
_DEFAULT_URL = "postgresql+psycopg://findaspot:findaspot@localhost:5432/findaspot"


def _load_dotenv() -> None:
    """Minimal .env loader — sets any KEY=VALUE lines not already in the
    environment. Avoids a hard dependency on python-dotenv."""
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL", _DEFAULT_URL)

# pool_pre_ping avoids handing out a connection the DB has already dropped
# (e.g. after `docker compose restart`); future=True keeps 2.0 semantics.
engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional scope: commit on success, roll back on error, always
    close. Used by the repository and the migration script."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a request-scoped session. The endpoint
    (or repository call) is responsible for committing; we roll back and
    close here so a failed request never leaks an open transaction."""
    session = SessionLocal()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
