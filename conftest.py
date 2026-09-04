"""Ensure the project root is importable (api.*, src.*, scripts.*) under pytest."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
