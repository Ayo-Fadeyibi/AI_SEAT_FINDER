#!/usr/bin/env python3
"""
Re-lay-out every existing seat to match what the admin Layout Editor's
"Add Table"/"Add Seat" tools actually produce: uniform DEFAULT_SEAT_SIZE
squares arranged in a grid below their table, instead of whatever the
one-time legacy-seats migration originally computed (a seat inheriting
the table's own bbox, or thin slices spanning the table's width/height).

Only touches seat x/y/width/height — table position/size, seat
occupancyStatus, and every other field are left untouched. Table-level
bbox in the derived data/seats.json comes from the TABLE's own bbox, not
the seat's, so this has no effect on what students see in the finder;
it's purely a visual fix for the admin's Layout tab canvas.

Mirrors LayoutEditor.tsx's arrangeSeatPositions()/DEFAULT_SEAT_SIZE — keep
the two in sync if either changes.

Usage:
    python scripts/normalize_seat_layout.py
"""

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.utils.config import DATA_DIR

LAYOUT_PATH = DATA_DIR / "layout.json"
DEFAULT_SEAT_SIZE = 22
GAP = 4


def clamp(value: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return lo
    return min(max(value, lo), hi)


def arrange_seat_positions(x: float, y: float, width: float, height: float, count: int,
                            canvas_width: float, canvas_height: float) -> list[tuple[float, float]]:
    cols = max(1, min(count, max(1, int(width // (DEFAULT_SEAT_SIZE + GAP))), 6))
    positions = []
    for i in range(count):
        col = i % cols
        row = i // cols
        sx = clamp(x + col * (DEFAULT_SEAT_SIZE + GAP), 0, canvas_width - DEFAULT_SEAT_SIZE)
        sy = clamp(y + height + 6 + row * (DEFAULT_SEAT_SIZE + GAP), 0, canvas_height - DEFAULT_SEAT_SIZE)
        positions.append((sx, sy))
    return positions


def main() -> None:
    layout = json.loads(LAYOUT_PATH.read_text())
    objects = layout["objects"]
    canvas_width = layout.get("canvasWidth", 760)
    canvas_height = layout.get("canvasHeight", 510)

    tables = {o["id"]: o for o in objects if o["type"] == "table"}
    seats_by_table: dict[str, list[dict]] = {}
    for o in objects:
        if o["type"] == "seat" and o.get("tableId"):
            seats_by_table.setdefault(o["tableId"], []).append(o)

    fixed = 0
    for table_id, seats in seats_by_table.items():
        table = tables.get(table_id)
        if not table:
            continue  # orphaned seat, nothing to anchor it to — leave as-is
        # Stable order: sort by the numeric seat suffix so S1/S2/... stay in
        # a predictable left-to-right, top-to-bottom order after the fix.
        def seat_num(s):
            try:
                return int(s["id"].rsplit("S", 1)[1])
            except (IndexError, ValueError):
                return 0
        seats.sort(key=seat_num)

        positions = arrange_seat_positions(
            table["x"], table["y"], table["width"], table["height"],
            len(seats), canvas_width, canvas_height,
        )
        for seat, (sx, sy) in zip(seats, positions):
            seat["x"] = sx
            seat["y"] = sy
            seat["width"] = DEFAULT_SEAT_SIZE
            seat["height"] = DEFAULT_SEAT_SIZE
            fixed += 1

    LAYOUT_PATH.write_text(json.dumps(layout, indent=2, ensure_ascii=False))
    print(f"Normalized {fixed} seat(s) across {len(seats_by_table)} table(s).")


if __name__ == "__main__":
    main()
