"""
Data-access layer over PostgreSQL — replaces the former data/*.json file
helpers in api/server.py. Every function returns/accepts the SAME JSON shapes
the endpoints used before, so the REST contracts are unchanged.

Read functions are self-contained (own short transaction). The check-in /
occupancy mutations are composite and run in a SINGLE transaction with row
locking, which is the whole point of the migration: the old whole-file
read-modify-write could silently clobber concurrent writers.
"""

import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, text, update

from api.db import session_scope
from api.models import (
    Amenity,
    AdminLog,
    AdminUser,
    Camera,
    CheckIn,
    Floor,
    Points,
    Seat,
    Table,
)

# Grace window an expired, unconfirmed self-check-in keeps its seat before the
# lazy auto-release frees it. Mirrored by the frontend (App.tsx) and imported
# by api/server.py — single source of truth lives here now.
CHECKIN_GRACE_MINUTES = 15


class RepositoryError(Exception):
    """Domain error carrying an HTTP status + detail; endpoints translate it
    into an HTTPException so the data layer stays framework-agnostic."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


# ═══════════════════════════════════════════════════════════════════════
# Flat-object mapping (layout.json <-> normalized rows)
# ═══════════════════════════════════════════════════════════════════════
# Key order matches the original layout.json objects so layout GET is
# byte-identical. Seats/amenities never carried per-object name/zone/equipment
# in this app (always empty), so those are emitted as constants.

def _table_to_object(t: Table) -> dict:
    return {
        "id": t.id, "type": "table", "x": t.x, "y": t.y, "width": t.width, "height": t.height,
        "name": t.name, "location": t.location, "rotation": t.rotation, "zoneType": t.zone_type,
        "capacity": t.capacity, "equipment": list(t.equipment or []), "floor": t.floor,
        "color": t.color, "tableId": None, "occupancyStatus": None, "amenityType": None,
    }


def _seat_to_object(s: Seat) -> dict:
    return {
        "id": s.id, "type": "seat", "x": s.x, "y": s.y, "width": s.width, "height": s.height,
        "name": "", "location": "", "rotation": s.rotation, "zoneType": "",
        "capacity": s.capacity, "equipment": [], "floor": s.floor,
        "color": s.color, "tableId": s.table_id, "occupancyStatus": s.occupancy_status, "amenityType": None,
    }


def _amenity_to_object(a: Amenity) -> dict:
    return {
        "id": a.id, "type": "amenity", "x": a.x, "y": a.y, "width": a.width, "height": a.height,
        "name": a.name, "location": "", "rotation": a.rotation, "zoneType": "",
        "capacity": a.capacity, "equipment": [], "floor": a.floor,
        "color": a.color, "tableId": None, "occupancyStatus": None, "amenityType": a.amenity_type,
    }


# ═══════════════════════════════════════════════════════════════════════
# Layout — GET reconstruction + POST replace
# ═══════════════════════════════════════════════════════════════════════

def get_layout(canvas_width: float, canvas_height: float) -> dict:
    """Reconstruct the flat {objects, floors, canvasWidth, canvasHeight} the
    editor round-trips, ordered by the original object ordinal."""
    with session_scope() as s:
        objs: list[tuple[int, dict]] = []
        for t in s.scalars(select(Table)):
            objs.append((t.ordinal, _table_to_object(t)))
        for seat in s.scalars(select(Seat)):
            objs.append((seat.ordinal, _seat_to_object(seat)))
        for a in s.scalars(select(Amenity)):
            objs.append((a.ordinal, _amenity_to_object(a)))
        objs.sort(key=lambda p: p[0])
        floors = [
            {"number": f.number, "label": f.label}
            for f in s.scalars(select(Floor).order_by(Floor.number))
        ]
    return {
        "objects": [o for _, o in objs],
        "floors": floors,
        "canvasWidth": canvas_width,
        "canvasHeight": canvas_height,
    }


def replace_layout(objects: list[dict], floors: list[dict]) -> int:
    """Persist the whole floor plan. Upserts every object and deletes ones no
    longer present, all in one transaction. Upsert (not truncate+insert) is
    deliberate: it preserves seat rows — and therefore any live check-ins FK'd
    to them — for seats that still exist. Returns the count of tables that have
    at least one child seat (matches the old 'N table(s) exported' log)."""
    with session_scope() as s:
        new_floor_numbers = {f["number"] for f in floors}
        new_table_ids, new_seat_ids, new_amenity_ids = set(), set(), set()

        for i, o in enumerate(objects):
            typ = o.get("type")
            if typ == "table":
                new_table_ids.add(o["id"])
            elif typ == "seat":
                new_seat_ids.add(o["id"])
            elif typ == "amenity":
                new_amenity_ids.add(o["id"])

        # Upsert floors + tables first (FK targets), then seats, then amenities.
        for f in floors:
            s.merge(Floor(number=f["number"], label=f.get("label", "")))

        for i, o in enumerate(objects):
            if o.get("type") != "table":
                continue
            s.merge(Table(
                id=o["id"], ordinal=i, floor=o.get("floor", 1),
                x=o.get("x", 0.0), y=o.get("y", 0.0), width=o.get("width", 0.0),
                height=o.get("height", 0.0), rotation=o.get("rotation", 0.0), color=o.get("color", ""),
                name=o.get("name", ""), location=o.get("location", ""),
                zone_type=o.get("zoneType", "quiet"), capacity=o.get("capacity", 1),
                equipment=list(o.get("equipment", [])),
            ))
        s.flush()

        for i, o in enumerate(objects):
            if o.get("type") != "seat":
                continue
            s.merge(Seat(
                id=o["id"], ordinal=i, table_id=o.get("tableId"), floor=o.get("floor", 1),
                x=o.get("x", 0.0), y=o.get("y", 0.0), width=o.get("width", 0.0),
                height=o.get("height", 0.0), rotation=o.get("rotation", 0.0), color=o.get("color", ""),
                capacity=o.get("capacity", 1),
                occupancy_status=o.get("occupancyStatus") or "available",
            ))

        for i, o in enumerate(objects):
            if o.get("type") != "amenity":
                continue
            s.merge(Amenity(
                id=o["id"], ordinal=i, floor=o.get("floor", 1),
                x=o.get("x", 0.0), y=o.get("y", 0.0), width=o.get("width", 0.0),
                height=o.get("height", 0.0), rotation=o.get("rotation", 0.0), color=o.get("color", ""),
                capacity=o.get("capacity", 0), name=o.get("name", ""), amenity_type=o.get("amenityType"),
            ))
        s.flush()

        # Delete rows no longer in the layout (seats/amenities before their
        # FK parents; a stale table cascade-deletes any remaining child seats).
        s.execute(delete(Seat).where(Seat.id.notin_(new_seat_ids or {""})))
        s.execute(delete(Amenity).where(Amenity.id.notin_(new_amenity_ids or {""})))
        s.execute(delete(Table).where(Table.id.notin_(new_table_ids or {""})))
        s.execute(delete(Floor).where(Floor.number.notin_(new_floor_numbers or {-1})))

        table_count = s.scalar(
            select(func.count(func.distinct(Seat.table_id))).select_from(Seat)
        )
        return table_count or 0


def list_amenities() -> list[dict]:
    with session_scope() as s:
        return [
            _amenity_to_object(a)
            for a in s.scalars(select(Amenity).order_by(Amenity.ordinal))
        ]


def list_chairs(table_id: str | None = None) -> list[dict]:
    with session_scope() as s:
        stmt = select(Seat).order_by(Seat.ordinal)
        if table_id is not None:
            stmt = stmt.where(Seat.table_id == table_id)
        return [
            {"id": s_.id, "tableId": s_.table_id, "floor": s_.floor, "occupancyStatus": s_.occupancy_status}
            for s_ in s.scalars(stmt)
        ]


def get_floors() -> list[dict]:
    with session_scope() as s:
        return [
            {"number": f.number, "label": f.label}
            for f in s.scalars(select(Floor).order_by(Floor.number))
        ]


def get_seat_floor(seat_id: str) -> int | None:
    """Floor of an individual chair, or None if it doesn't exist."""
    with session_scope() as s:
        return s.scalar(select(Seat.floor).where(Seat.id == seat_id))


# ═══════════════════════════════════════════════════════════════════════
# Table-level availability (the former seats.json / v_table_availability)
# ═══════════════════════════════════════════════════════════════════════

_AVAILABILITY_SQL = text("""
    SELECT id, name_zh, name_en, zone_type, capacity, available_seats,
           equipment, floor, location_zh, location_en, occupancy_status, bbox
    FROM v_table_availability
""")


def query_table_availability() -> list[dict]:
    """Return the same list of table-level dicts the old data/seats.json held
    (keys: id, name_zh, name_en, zoneType, capacity, availableSeats, equipment,
    floor, location_zh, location_en, occupancyStatus, bbox)."""
    with session_scope() as s:
        rows = s.execute(_AVAILABILITY_SQL).mappings().all()
    return [
        {
            "id": r["id"], "name_zh": r["name_zh"], "name_en": r["name_en"],
            "zoneType": r["zone_type"], "capacity": int(r["capacity"]),
            "availableSeats": int(r["available_seats"]), "equipment": list(r["equipment"] or []),
            "floor": r["floor"], "location_zh": r["location_zh"], "location_en": r["location_en"],
            "occupancyStatus": r["occupancy_status"], "bbox": list(r["bbox"]),
        }
        for r in rows
    ]


# ═══════════════════════════════════════════════════════════════════════
# Occupancy
# ═══════════════════════════════════════════════════════════════════════

def _apply_occupancy(session, status_map: dict[str, str]) -> int:
    """Set {seat_id: status} atomically. Only 'available'/'occupied' are
    honored; unknown seat ids and no-op writes count as 0 (matches the old
    _apply_occupancy semantics)."""
    updated = 0
    for seat_id, status in status_map.items():
        if status not in ("available", "occupied"):
            continue
        res = session.execute(
            update(Seat)
            .where(Seat.id == seat_id, Seat.occupancy_status != status)
            .values(occupancy_status=status)
        )
        updated += res.rowcount or 0
    return updated


def apply_occupancy(status_map: dict[str, str]) -> int:
    with session_scope() as s:
        return _apply_occupancy(s, status_map)


def set_seat_status(seat_id: str, status: str) -> int:
    """Admin single-seat toggle. Raises 404 if the chair doesn't exist."""
    with session_scope() as s:
        floor = s.scalar(select(Seat.floor).where(Seat.id == seat_id))
        if floor is None:
            raise RepositoryError(404, "Seat not found")
        _apply_occupancy(s, {seat_id: status})
        _add_log(s, "seat_update", f"Seat {seat_id} → {status}", floor)
        return floor


# ═══════════════════════════════════════════════════════════════════════
# Points
# ═══════════════════════════════════════════════════════════════════════

def _award_point(session, nickname: str | None) -> int | None:
    if not nickname:
        return None
    p = session.get(Points, nickname, with_for_update=True)
    if p is None:
        p = Points(nickname=nickname, points=0)
        session.add(p)
    p.points += 1
    session.flush()
    return p.points


def get_points(nickname: str) -> int:
    key = nickname.strip()[:24]
    with session_scope() as s:
        return s.scalar(select(Points.points).where(Points.nickname == key)) or 0


def leaderboard(limit: int = 10) -> list[dict]:
    with session_scope() as s:
        rows = s.execute(
            select(Points.nickname, Points.points)
            .order_by(Points.points.desc())
            .limit(limit)
        ).all()
    return [{"nickname": n, "points": p} for n, p in rows]


# ═══════════════════════════════════════════════════════════════════════
# Check-ins (composite, single-transaction, row-locked)
# ═══════════════════════════════════════════════════════════════════════

def _release_expired_checkins(session) -> int:
    now = datetime.now()
    cutoff = now - timedelta(minutes=CHECKIN_GRACE_MINUTES)
    expired = session.scalars(select(CheckIn).where(CheckIn.expires_at < cutoff)).all()
    if not expired:
        return 0
    _apply_occupancy(session, {c.seat_id: "available" for c in expired})
    for c in expired:
        session.delete(c)
    _add_log(session, "checkin_auto_release", f"Auto-released {len(expired)} unconfirmed check-in(s)")
    return len(expired)


def release_expired_checkins() -> int:
    """Public entry point called at the top of the seat/chair read endpoints
    so stale check-ins self-heal even with no client tab open."""
    with session_scope() as s:
        return _release_expired_checkins(s)


def checkin(seat_id: str, duration_minutes: int, nickname: str | None) -> dict:
    with session_scope() as s:
        _release_expired_checkins(s)
        seat = s.get(Seat, seat_id, with_for_update=True)
        if seat is None:
            raise RepositoryError(404, "Seat not found")
        if seat.occupancy_status == "occupied":
            raise RepositoryError(409, "This seat is already marked occupied")

        now = datetime.now()
        nick = (nickname or "").strip()[:24] or None
        cid = uuid.uuid4().hex[:12]
        expires = now + timedelta(minutes=duration_minutes)
        seat.occupancy_status = "occupied"
        s.add(CheckIn(
            id=cid, seat_id=seat_id, nickname=nick,
            duration_minutes=duration_minutes, checked_in_at=now, expires_at=expires,
        ))
        points = _award_point(s, nick)
        _add_log(s, "checkin",
                 f"Self check-in at seat {seat_id}" + (f" by '{nick}'" if nick else ""),
                 seat.floor)
        return {
            "checkinId": cid, "seatId": seat_id, "expiresAt": expires.isoformat(),
            "durationMinutes": duration_minutes, "points": points,
        }


def confirm_checkin(checkin_id: str) -> dict:
    with session_scope() as s:
        _release_expired_checkins(s)
        c = s.get(CheckIn, checkin_id, with_for_update=True)
        if c is None:
            raise RepositoryError(404, "Check-in not found — it may have already expired")
        c.expires_at = datetime.now() + timedelta(minutes=c.duration_minutes)
        points = _award_point(s, c.nickname)
        _add_log(s, "checkin_confirm", f"Confirmed still at seat {c.seat_id}")
        return {"checkinId": checkin_id, "expiresAt": c.expires_at.isoformat(), "points": points}


def checkout(checkin_id: str) -> dict:
    with session_scope() as s:
        c = s.get(CheckIn, checkin_id, with_for_update=True)
        if c is None:
            raise RepositoryError(404, "Check-in not found — it may have already expired")
        _apply_occupancy(s, {c.seat_id: "available"})
        points = _award_point(s, c.nickname)
        s.delete(c)
        _add_log(s, "checkout", f"Checked out of seat {c.seat_id}")
        return {"status": "ok", "points": points}


def load_checkins() -> list[dict]:
    """Active check-ins in the old data/checkins.json shape — used by the
    analytics peak-hours aggregation."""
    with session_scope() as s:
        rows = s.scalars(select(CheckIn).order_by(CheckIn.checked_in_at)).all()
        return [
            {
                "id": c.id, "seatId": c.seat_id, "nickname": c.nickname,
                "durationMinutes": c.duration_minutes,
                "checkedInAt": c.checked_in_at.isoformat(),
                "expiresAt": c.expires_at.isoformat(),
            }
            for c in rows
        ]


# ═══════════════════════════════════════════════════════════════════════
# Admin logs
# ═══════════════════════════════════════════════════════════════════════

def _add_log(session, action: str, detail: str, floor: int | None = None) -> None:
    session.add(AdminLog(action=action, detail=detail, floor=floor, ts=datetime.now()))


def add_log(action: str, detail: str, floor: int | None = None) -> None:
    with session_scope() as s:
        _add_log(s, action, detail, floor)


def _log_to_dict(r: AdminLog) -> dict:
    return {
        "id": str(r.id), "action": r.action, "detail": r.detail,
        "floor": r.floor, "timestamp": r.ts.isoformat(),
    }


def recent_logs(limit: int = 50) -> list[dict]:
    """Most recent `limit` logs, newest first (matches the old logs[-limit:][::-1])."""
    with session_scope() as s:
        rows = s.execute(
            select(AdminLog).order_by(AdminLog.ts.desc(), AdminLog.id.desc()).limit(limit)
        ).scalars().all()
    return [_log_to_dict(r) for r in rows]


def all_logs() -> list[dict]:
    """Every log in chronological order — used by the analytics aggregation,
    which counts check-in/checkout activity over time."""
    with session_scope() as s:
        rows = s.scalars(select(AdminLog).order_by(AdminLog.ts, AdminLog.id)).all()
    return [_log_to_dict(r) for r in rows]


# ═══════════════════════════════════════════════════════════════════════
# Admin users (backing store for src/utils/admin_auth.py)
# ═══════════════════════════════════════════════════════════════════════

def load_users() -> list[dict]:
    with session_scope() as s:
        return [
            {"username": u.username, "salt": u.salt, "password_hash": u.password_hash}
            for u in s.scalars(select(AdminUser).order_by(AdminUser.username))
        ]


def save_users(users: list[dict]) -> None:
    """Replace the whole admin_users set (mirrors the old save_users file
    rewrite; small table, called only on add/remove)."""
    with session_scope() as s:
        s.execute(delete(AdminUser))
        for u in users:
            s.add(AdminUser(username=u["username"], salt=u["salt"], password_hash=u["password_hash"]))


# ═══════════════════════════════════════════════════════════════════════
# Cameras
# ═══════════════════════════════════════════════════════════════════════

def _camera_to_dict(c: Camera) -> dict:
    return {
        "id": c.id, "floor": c.floor, "label": c.label, "image": c.image,
        "imageWidth": c.image_width, "imageHeight": c.image_height,
        "calibratedAt": c.calibrated_at.isoformat() if c.calibrated_at else None,
        "seatBoxes": list(c.seat_boxes or []),
    }


def list_cameras(floor: int | None = None) -> list[dict]:
    with session_scope() as s:
        stmt = select(Camera).order_by(Camera.id)
        if floor is not None:
            stmt = stmt.where(Camera.floor == floor)
        return [_camera_to_dict(c) for c in s.scalars(stmt)]


def get_camera(cam_id: str) -> dict | None:
    with session_scope() as s:
        c = s.get(Camera, cam_id)
        return _camera_to_dict(c) if c else None


def add_camera(camera: dict) -> dict:
    with session_scope() as s:
        s.add(Camera(
            id=camera["id"], floor=camera["floor"], label=camera.get("label", ""),
            image=camera.get("image", ""), image_width=camera.get("imageWidth"),
            image_height=camera.get("imageHeight"),
            calibrated_at=None, seat_boxes=camera.get("seatBoxes", []),
        ))
    return camera


def save_calibration(cam_id: str, seat_boxes: list[dict]) -> dict:
    """Store a camera's per-seat boxes + calibration timestamp. Raises 404 if
    the camera is gone. Returns {label, floor, seatBoxes} for the caller's log."""
    with session_scope() as s:
        c = s.get(Camera, cam_id, with_for_update=True)
        if c is None:
            raise RepositoryError(404, "Camera not found")
        c.seat_boxes = seat_boxes
        c.calibrated_at = datetime.now()
        return {"label": c.label, "floor": c.floor, "seatBoxes": list(seat_boxes)}


def delete_camera(cam_id: str) -> dict:
    """Delete a camera row. Returns {label, floor, image} so the endpoint can
    remove the image file + log. Raises 404 if not found."""
    with session_scope() as s:
        c = s.get(Camera, cam_id)
        if c is None:
            raise RepositoryError(404, "Camera not found")
        info = {"label": c.label, "floor": c.floor, "image": c.image}
        s.delete(c)
        return info
