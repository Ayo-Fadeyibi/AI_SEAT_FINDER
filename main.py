"""
FindaSpot entrypoint.

Usage:
    python main.py              # Start web servers (backend + frontend) ← 默认
    python main.py --repl       # Start interactive REPL
    python main.py --demo       # Run demo queries automatically
"""

import subprocess
import sys
import time
import shutil
from pathlib import Path

from src.intent_parser.parser import parse
from src.optimizer.optimizer import load_seats, recommend
from src.utils.formatter import format_seat_output, format_intent
from src.utils.language import t, switch_lang, get_lang


def _find_python() -> str:
    """Find the best Python interpreter: prefer .venv, fallback to system."""
    project_root = Path(__file__).resolve().parent
    venv_python = project_root / ".venv" / "bin" / "python"
    if venv_python.exists():
        return str(venv_python)
    # Fallback: find python3 on PATH
    p = shutil.which("python3") or shutil.which("python")
    if p:
        return p
    print("ERROR: Python not found. Please install Python 3.10+")
    sys.exit(1)


def _check_node() -> str:
    """Find Node.js on PATH."""
    n = shutil.which("node")
    if n:
        return n
    return ""


def run_single_query(query: str, seats: list[dict]) -> None:
    """Process a single query: parse intent → recommend.

    Occupancy is read straight from seats.json — whatever the admin panel or
    YOLO camera detection last set — exactly like the web /api/recommend
    endpoint. The CLI does no occupancy simulation of its own.
    """
    print(f"\n{t('parsing')}")
    parsed_intent = parse(query)
    print(format_intent(parsed_intent))

    seat, match_type = recommend(parsed_intent, seats)

    print(f"\n{t('recommend_title')}")
    if match_type == "perfect":
        print(t("perfect_match"))
    elif match_type == "alternative":
        print(t("no_seat"))
    elif match_type == "none":
        print(t("empty_msg"))
        return

    print(format_seat_output(seat, match_type))


def run_demo():
    """Interactive REPL mode."""
    print(t("app_title"))
    print(t("commands_tip"))

    print(f"\n{t('demo_queries')}")
    print(t("demo_q1"))
    print(t("demo_q2"))
    print(t("demo_q3"))

    seats = load_seats()

    while True:
        try:
            user_input = input(f"\n{t('input_tip')} ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!")
            break

        if not user_input:
            continue
        if user_input.lower() == "exit":
            print("Goodbye!" if get_lang() == "en" else "再见！")
            break

        if user_input in ("zh", "en"):
            switch_lang(user_input)
            print(t("lang_switched"))
            continue

        run_single_query(user_input, seats)


def run_auto_demo():
    """Run pre-defined demo queries automatically."""
    print(t("app_title"))
    print()

    seats = load_seats()

    demo_queries = {
        "zh": [
            "我想要安静区、适合独立学习、有充电口的座位",
            "找个能4个人一起讨论的地方",
            "有没有安静的双人座，需要充电",
        ],
        "en": [
            "I want a quiet seat for individual study with a power outlet",
            "Need a group study spot for 4 people",
            "Any quiet seat for two? Need charging.",
        ],
    }

    for lang in ("zh", "en"):
        switch_lang(lang)
        print(f"\n{'='*50}")
        print(f"  Language: {'中文' if lang == 'zh' else 'English'}")
        print(f"{'='*50}")

        for query in demo_queries[lang]:
            print(f"\n{'─'*40}")
            print(f"  User: {query}")
            print(f"{'─'*40}")
            run_single_query(query, seats)

    switch_lang("en")


def _ensure_database(python_bin: str, project_root: Path) -> bool:
    """Bring up the PostgreSQL container, apply migrations, and seed from
    data/*.json on first run. Returns False if the DB can't be reached."""
    import time

    print("  [0/2] Preparing database...")
    # Start the compose DB (no-op if already running). If docker isn't
    # installed, assume DATABASE_URL points at an externally-managed Postgres.
    try:
        subprocess.run(
            ["docker", "compose", "up", "-d", "db"],
            cwd=str(project_root), check=True, capture_output=True, text=True,
        )
    except FileNotFoundError:
        print("  ⚠ docker not found — assuming DATABASE_URL points at a running PostgreSQL.")
    except subprocess.CalledProcessError as e:
        print(f"  ⚠ 'docker compose up' failed: {(e.stderr or '').strip()[:200]}")

    # Wait until the DB accepts connections.
    probe = "from api.db import engine; from sqlalchemy import text; engine.connect().execute(text('SELECT 1'))"
    for _ in range(30):
        if subprocess.run([python_bin, "-c", probe], cwd=str(project_root), capture_output=True).returncode == 0:
            break
        time.sleep(1)
    else:
        print("  ✘ Database not reachable — is Docker running? See docs/database.md.")
        return False

    subprocess.run([python_bin, "-m", "alembic", "upgrade", "head"], cwd=str(project_root), capture_output=True, text=True)

    # Seed from the legacy JSON only when the DB is still empty.
    r = subprocess.run(
        [python_bin, "-c", "from api.repository import get_floors; print(len(get_floors()))"],
        cwd=str(project_root), capture_output=True, text=True,
    )
    if r.stdout.strip() == "0":
        print("  Seeding database from data/*.json ...")
        subprocess.run([python_bin, "scripts/migrate_json_to_db.py"], cwd=str(project_root))
    print("  ✔ Database ready")
    return True


def run_web():
    """Start backend (FastAPI) + frontend (Vite) servers."""
    import socket

    project_root = Path(__file__).resolve().parent
    python_bin = _find_python()
    frontend_dir = project_root / "frontend"

    print()
    print("  ┌──────────────────────────────────────────┐")
    print("  │         FindaSpot 座位推荐系统            │")
    print("  └──────────────────────────────────────────┘")
    print()

    # ── Kill any existing processes on these ports ──
    for port in (8000, 5173):
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True, text=True,
            )
            for pid in result.stdout.strip().split("\n"):
                if pid:
                    import os
                    os.kill(int(pid), 9)
        except Exception:
            pass

    # ── Ensure PostgreSQL is up + migrated + seeded ──
    if not _ensure_database(python_bin, project_root):
        return

    # ── Start FastAPI backend ──
    print("  [1/2] Starting backend...")
    backend = subprocess.Popen(
        [python_bin, "api/server.py"],
        cwd=str(project_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    backend_ready = False
    for _ in range(30):
        time.sleep(0.5)
        if backend.poll() is not None:
            out = backend.stdout.read() if backend.stdout else ""
            print(f"  ERROR: Backend failed to start!\n  {out}")
            return
        try:
            socket.create_connection(("localhost", 8000), timeout=1).close()
            backend_ready = True
            break
        except OSError:
            continue

    if not backend_ready:
        print("  ERROR: Backend timed out!")
        backend.terminate()
        return
    print("  ✔ Backend ready: http://localhost:8000")

    # ── Start Vite frontend ──
    print("  [2/2] Starting frontend...")
    node_bin = _check_node()
    if not node_bin:
        print("  ERROR: Node.js not found!")
        print("  Please install Node.js 18+ from https://nodejs.org/")
        backend.terminate()
        return

    frontend = subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=str(frontend_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    frontend_ready = False
    for _ in range(30):
        time.sleep(0.5)
        if frontend.poll() is not None:
            out = frontend.stdout.read() if frontend.stdout else ""
            print(f"  ERROR: Frontend failed to start!\n  {out}")
            backend.terminate()
            return
        try:
            socket.create_connection(("localhost", 5173), timeout=1).close()
            frontend_ready = True
            break
        except OSError:
            continue

    if not frontend_ready:
        print("  ERROR: Frontend timed out!")
        backend.terminate()
        frontend.terminate()
        return
    print("  ✔ Frontend ready")

    # ── Print access URL ──
    url = "http://localhost:5173/"
    print()
    print("  ┌──────────────────────────────────────────┐")
    print("  │                                          │")
    print(f"  │   Open in browser:                       │")
    print("  │                                          │")
    print(f"  │   >>>  {url}  <<<   │")
    print("  │                                          │")
    print("  │   Press Ctrl+C to stop.                  │")
    print("  │                                          │")
    print("  └──────────────────────────────────────────┘")
    print()

    # ── Keep running until Ctrl+C ──
    try:
        while True:
            time.sleep(1)
            if backend.poll() is not None:
                print("\nBackend stopped.")
                break
            if frontend.poll() is not None:
                print("\nFrontend stopped.")
                break
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        backend.terminate()
        frontend.terminate()
        try:
            backend.wait(timeout=5)
        except Exception:
            backend.kill()
        try:
            frontend.wait(timeout=5)
        except Exception:
            frontend.kill()
        print("All servers stopped.")


if __name__ == "__main__":
    if "--repl" in sys.argv:
        run_demo()
    elif "--demo" in sys.argv:
        run_auto_demo()
    else:
        run_web()
