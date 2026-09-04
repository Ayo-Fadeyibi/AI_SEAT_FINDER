"""
One-time loader: import the legacy data/*.json store into PostgreSQL.

Idempotent — truncates every table (RESTART IDENTITY CASCADE) then re-inserts,
so it is safe to re-run. Requires the schema to exist first:

    docker compose up -d db
    alembic upgrade head
    python scripts/migrate_json_to_db.py

Reads whichever layout representation is present: the authoritative
data/layout.json if populated, otherwise the legacy flat data/seats.json
(converted to tables + child seats the same way api/server.py used to).
"""

import json
import sys
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from sqlalchemy import text  # noqa: E402

from api import repository  # noqa: E402
from api.db import session_scope  # noqa: E402
from api.models import AdminLog, AdminUser, Camera, CheckIn, Points  # noqa: E402

DATA_DIR = PROJECT_ROOT / "data"
CANVAS_WIDTH, CANVAS_HEIGHT = 760, 510

# Every table, children before parents, so a single TRUNCATE ... CASCADE
# resets the whole store cleanly.
_ALL_TABLES = (
    "checkins", "seats", "amenities", "tables", "floors",
    "points", "admin_users", "admin_logs", "cameras",
)


def _read_json(name: str, default):
    path = DATA_DIR / name
    if not path.exists():
        return default
    return json.loads(path.read_text())


def _legacy_seats_to_objects(seats: list[dict]) -> tuple[list[dict], list[dict]]:
    """Mirror api/server.py::_migrate_legacy_seats_if_needed for the case where
    only the old flat seats.json exists (no layout.json objects yet)."""
    objects: list[dict] = []
    floor_numbers: set[int] = set()
    for s in seats:
        n = max(1, s.get("capacity", 1))
        x, y, w, h = s["bbox"]
        objects.append({
            "id": s["id"], "type": "table", "x": x, "y": y, "width": w, "height": h,
            "name": s.get("name_en", ""), "location": s.get("location_en", ""), "rotation": 0,
            "zoneType": s.get("zoneType", "quiet"), "capacity": n,
            "equipment": s.get("equipment", []), "floor": s.get("floor", 1), "color": "",
        })
        seat_w = w / n
        for i in range(n):
            objects.append({
                "id": f"{s['id']}-S{i + 1}", "type": "seat",
                "x": x + i * seat_w, "y": y, "width": seat_w, "height": h,
                "name": "", "rotation": 0, "zoneType": "", "capacity": 1,
                "equipment": [], "floor": s.get("floor", 1), "color": "",
                "tableId": s["id"], "occupancyStatus": s.get("occupancyStatus", "available"),
            })
        floor_numbers.add(s.get("floor", 1))
    floors = [{"number": f, "label": ""} for f in sorted(floor_numbers)]
    return objects, floors


def _load_layout() -> tuple[list[dict], list[dict]]:
    layout = _read_json("layout.json", {})
    objects = layout.get("objects", [])
    if objects:
        floors = layout.get("floors", [])
        # Guard the seats/amenities-carry-no-meta assumption the DB relies on.
        for o in objects:
            if o.get("type") == "seat":
                assert not o.get("name") and not o.get("zoneType") and not o.get("equipment"), \
                    f"seat {o['id']} carries per-object metadata the schema drops"
        return objects, floors
    # Fall back to legacy flat seats.json.
    seats = _read_json("seats.json", {"seats": []}).get("seats", [])
    return _legacy_seats_to_objects(seats)


def main() -> None:
    objects, floors = _load_layout()
    checkins = _read_json("checkins.json", {"checkins": []}).get("checkins", [])
    points = _read_json("points.json", {})
    users = _read_json("admin_users.json", [])
    logs = _read_json("admin_logs.json", [])
    cameras = _read_json("camera_calibration.json", {"cameras": []}).get("cameras", [])

    # ── Wipe (idempotent) ──
    with session_scope() as s:
        s.execute(text(f"TRUNCATE {', '.join(_ALL_TABLES)} RESTART IDENTITY CASCADE"))

    # ── Layout (floors/tables/seats/amenities) via the same code the app uses ──
    table_count = repository.replace_layout(objects, floors)

    # ── Everything else ──
    with session_scope() as s:
        for u in users:
            s.add(AdminUser(username=u["username"], salt=u["salt"], password_hash=u["password_hash"]))
        for nick, pts in points.items():
            s.add(Points(nickname=nick, points=int(pts)))
        for c in checkins:
            s.add(CheckIn(
                id=c["id"], seat_id=c["seatId"], nickname=c.get("nickname"),
                duration_minutes=c["durationMinutes"],
                checked_in_at=datetime.fromisoformat(c["checkedInAt"]),
                expires_at=datetime.fromisoformat(c["expiresAt"]),
            ))
        for lg in logs:
            s.add(AdminLog(
                action=lg["action"], detail=lg["detail"], floor=lg.get("floor"),
                ts=datetime.fromisoformat(lg["timestamp"]),
            ))
        for cam in cameras:
            s.add(Camera(
                id=cam["id"], floor=cam["floor"], label=cam.get("label", ""),
                image=cam.get("image", ""), image_width=cam.get("imageWidth"),
                image_height=cam.get("imageHeight"),
                calibrated_at=datetime.fromisoformat(cam["calibratedAt"]) if cam.get("calibratedAt") else None,
                seat_boxes=cam.get("seatBoxes", []),
            ))

    print(
        f"Migrated: {len(floors)} floor(s), {table_count} table(s) w/ seats, "
        f"{len([o for o in objects if o.get('type') == 'seat'])} seat(s), "
        f"{len([o for o in objects if o.get('type') == 'amenity'])} amenity(ies), "
        f"{len(checkins)} check-in(s), {len(points)} point row(s), "
        f"{len(users)} admin(s), {len(logs)} log(s), {len(cameras)} camera(s)."
    )


if __name__ == "__main__":
    main()
