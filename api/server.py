"""
FindaSpot REST API Server.

Wraps the core Python modules (intent_parser, optimizer, cv) as REST APIs
for the React frontend.

Includes admin endpoints (auth-gated) for the floor-plan editor and camera
calibration. Seat occupancy is a plain available/occupied flag per individual
seat — set by hand or by YOLO detection off a calibrated camera; we do not
track which individual is in any given seat.

Usage:
    python api/server.py
"""

import re
import secrets
import sys
import uuid
from collections import Counter
from pathlib import Path

# ── Add project root to sys.path so `src.*` imports work ──────────────
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI, HTTPException, Header, Depends, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

from src.intent_parser.parser import parse
from src.optimizer.optimizer import load_seats, recommend_all
from src.cv.detector import compute_seat_occupancy
from src.utils.admin_auth import load_users, save_users, hash_password, verify_password
from api import repository
from api.repository import RepositoryError

# ── Paths ────────────────────────────────────────────────────────────
# Persistent state now lives in PostgreSQL (see api/repository.py); only the
# camera snapshot images remain on disk.
DATA_DIR = PROJECT_ROOT / "data"
IMAGES_DIR = DATA_DIR / "images"
CAMERAS_IMG_DIR = IMAGES_DIR / "cameras"
CAMERAS_IMG_DIR.mkdir(parents=True, exist_ok=True)

# The floor-plan canvas is fixed at the finder's own SVG viewBox size
# (frontend/src/app/App.tsx) so editor coordinates need no transform to
# render correctly for students.
CANVAS_WIDTH = 760
CANVAS_HEIGHT = 510

# ── App setup ─────────────────────────────────────────────────────────
app = FastAPI(title="FindaSpot API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    # Vite has no fixed port — if 5173 is already taken (e.g. a prior dev
    # server didn't shut down cleanly) it silently falls back to 5174,
    # 5175, etc. A fixed origin list would then reject every admin
    # request with an opaque CORS error, so allow any localhost port.
    allow_origin_regex=r"^http://localhost:\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RepositoryError)
async def _repository_error_handler(_request, exc: RepositoryError):
    """Translate data-layer domain errors into the same {"detail": ...} JSON
    shape (and status) an HTTPException would produce, so the repository stays
    framework-agnostic and the API error contract is unchanged."""
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


# ── Request / Response models ─────────────────────────────────────────
class RecommendRequest(BaseModel):
    query: str
    lang: str = "zh"
    floor: int | None = None


class SeatStatusUpdate(BaseModel):
    status: str  # "available" or "occupied"


class CheckInRequest(BaseModel):
    seatId: str
    durationMinutes: int = 60  # 60 or 120 — student picks 1h or 2h at check-in
    nickname: str | None = None


class LoginRequest(BaseModel):
    username: str
    password: str


class AddAdminRequest(BaseModel):
    username: str
    password: str


# ═══════════════════════════════════════════════════════════════════════
# Admin auth — username/password, hashed + salted, bearer session tokens
# ═══════════════════════════════════════════════════════════════════════

# In-memory session store: token -> username. Cleared on server restart,
# which just means admins need to log in again — acceptable for this scale.
_sessions: dict[str, str] = {}


def require_admin(authorization: str | None = Header(default=None)) -> str:
    """FastAPI dependency: validates the Bearer token, returns the username."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing or malformed Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    username = _sessions.get(token)
    if not username:
        raise HTTPException(401, "Invalid or expired session")
    return username


# There is no PUBLIC signup endpoint — an unauthenticated visitor can never
# create an admin account. The first account is provisioned locally via
# `python scripts/create_admin.py` (shell access required); after that,
# any logged-in admin can add or remove other admins from within the app
# (see the /api/admin/users routes below).
@app.post("/api/admin/auth/login")
async def login(req: LoginRequest):
    users = load_users()
    user = next((u for u in users if u["username"] == req.username.strip()), None)
    if not user or not verify_password(req.password, user["salt"], user["password_hash"]):
        raise HTTPException(401, "Invalid username or password")

    token = secrets.token_hex(32)
    _sessions[token] = user["username"]
    repository.add_log("admin_login", f"{user['username']} logged in")
    return {"token": token, "username": user["username"]}


@app.post("/api/admin/auth/logout")
async def logout(username: str = Depends(require_admin), authorization: str = Header(default="")):
    token = authorization.removeprefix("Bearer ").strip()
    _sessions.pop(token, None)
    return {"status": "ok"}


@app.get("/api/admin/auth/me")
async def me(username: str = Depends(require_admin)):
    return {"username": username}


# ── Admin accounts — any logged-in admin can add/remove others ────────
# Flat model, no roles: matches the rest of this app's "logged in or not"
# permission scope. At least one admin account must always remain.

@app.get("/api/admin/users")
async def list_admins(username: str = Depends(require_admin)):
    users = load_users()
    return {"users": [u["username"] for u in users]}


@app.post("/api/admin/users")
async def add_admin(req: AddAdminRequest, username: str = Depends(require_admin)):
    new_username = req.username.strip()
    if not new_username or not req.password:
        raise HTTPException(400, "Username and password are required")
    if len(req.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    users = load_users()
    if any(u["username"] == new_username for u in users):
        raise HTTPException(400, "Username already taken")

    salt_hex, hash_hex = hash_password(req.password)
    users.append({"username": new_username, "salt": salt_hex, "password_hash": hash_hex})
    save_users(users)
    repository.add_log("admin_added", f"{username} added admin account '{new_username}'")

    return {"status": "ok", "username": new_username}


@app.delete("/api/admin/users/{target_username}")
async def delete_admin(target_username: str, username: str = Depends(require_admin)):
    users = load_users()
    if not any(u["username"] == target_username for u in users):
        raise HTTPException(404, "Admin not found")
    if len(users) <= 1:
        raise HTTPException(400, "Can't remove the last remaining admin account")

    users = [u for u in users if u["username"] != target_username]
    save_users(users)

    # Invalidate any active sessions for the removed account.
    for token, sess_user in list(_sessions.items()):
        if sess_user == target_username:
            _sessions.pop(token, None)

    repository.add_log("admin_removed", f"{username} removed admin account '{target_username}'")
    return {"status": "ok"}


# ── Routes ────────────────────────────────────────────────────────────
@app.get("/api/")
async def health_check():
    return {"status": "ok"}


@app.get("/api/seats")
async def get_seats():
    """Return all seats with current occupancy status."""
    repository.release_expired_checkins()
    return {"seats": load_seats()}


@app.get("/api/chairs")
async def get_chairs(tableId: str | None = None):
    """Individual seat/chair records — public, minimal fields only (no
    admin-only layout details like name/equipment). Distinct from the
    table-level aggregates /api/seats returns: this is what the self
    check-in flow uses to let a student pick their specific chair."""
    repository.release_expired_checkins()
    return {"chairs": repository.list_chairs(tableId)}


@app.get("/api/floors")
async def get_floors():
    """Return the admin-configured floor list (public — the finder's floor selector needs it)."""
    return {"floors": repository.get_floors()}


@app.get("/api/amenities")
async def get_amenities():
    """Return non-seat map markers (toilets, exits, etc.) — public, same trust
    level as /api/seats and /api/floors: the finder's map needs these too."""
    return {"amenities": repository.list_amenities()}


@app.post("/api/recommend")
async def recommend_seat(req: RecommendRequest):
    """Run full pipeline: parse intent → optimize → recommend."""
    seats = load_seats()

    # Step 1: Parse user intent via LLM
    parsed_intent = parse(req.query)

    # Step 1.5: Apply floor filter from UI if provided
    if req.floor is not None:
        parsed_intent["floor"] = req.floor

    # Step 2: Recommend every seat in the best-available tier, not just one
    # — a student should get to pick among equally-good options. Occupancy
    # on each seat is whatever the last CV/admin/check-in update set it to —
    # no per-visitor tracking involved. Amenities (toilets, stairs, ...) are
    # only consulted when the parsed intent asks for near/far proximity to
    # one — see optimizer.recommend_all.
    matches, match_type = recommend_all(parsed_intent, seats, repository.list_amenities())

    return {
        "intent": parsed_intent,
        "seat": matches[0] if matches else None,
        "seats": matches,
        "matchType": match_type,
    }


# ═══════════════════════════════════════════════════════════════════════
# Admin endpoints — Floor-plan editor
#
# data/layout.json is the editable source of truth: a flat list of
# positioned objects (tables, seats, and non-recommendable furniture like
# shelves/doors) plus a floor registry. data/seats.json — what the finder
# and the optimizer read — is always DERIVED from it, never edited
# directly, via _derive_seats_from_layout().
# ═══════════════════════════════════════════════════════════════════════

class LayoutObject(BaseModel):
    id: str = ""
    type: str  # table, seat, amenity
    x: float
    y: float
    width: float
    height: float
    name: str = ""
    location: str = ""  # free-text description, e.g. "East wing, near window" — tables only
    rotation: float = 0
    zoneType: str = ""
    capacity: int = 1
    equipment: list[str] = []
    floor: int = 1
    color: str = ""
    tableId: str | None = None          # set only on type=="seat" — parent table's id
    occupancyStatus: str | None = None  # set only on type=="seat"
    amenityType: str | None = None      # set only on type=="amenity" — toilet, exit, elevator, ...


class FloorMeta(BaseModel):
    number: int
    label: str = ""


class LayoutSaveRequest(BaseModel):
    objects: list[LayoutObject]
    floors: list[FloorMeta]
    canvasWidth: float = CANVAS_WIDTH
    canvasHeight: float = CANVAS_HEIGHT


@app.get("/api/admin/layout")
async def get_layout(username: str = Depends(require_admin)):
    """Load the saved floor plan (reconstructed from the normalized tables)."""
    return repository.get_layout(CANVAS_WIDTH, CANVAS_HEIGHT)


@app.post("/api/admin/layout")
async def save_layout(req: LayoutSaveRequest, username: str = Depends(require_admin)):
    """Save the full floor plan; table-level availability is derived from it on read."""
    objects = [obj.model_dump() for obj in req.objects]
    floors = [f.model_dump() for f in req.floors]
    table_count = repository.replace_layout(objects, floors)
    repository.add_log("layout_save", f"Saved floor plan, {table_count} table(s) with seats are live")
    return {"status": "ok", "seats_count": table_count}


# ═══════════════════════════════════════════════════════════════════════
# Admin management endpoints — Seats & dashboard
#
# Occupancy is a plain available/occupied flag per individual seat. This
# is a stand-in for what a computer-vision system would report
# automatically; we never track which individual is sitting where.
# ═══════════════════════════════════════════════════════════════════════

def _build_analytics_payload() -> dict:
    """Build a lightweight analytics payload from current seat state and the
    check-in/checkout activity log."""
    repository.release_expired_checkins()
    seats = load_seats()
    checkins = repository.load_checkins()
    logs = repository.all_logs()

    seat_usage = Counter(c.get("seatId") for c in checkins if c.get("seatId"))
    peak_hour_counts = Counter()
    for checkin in checkins:
        checked_in_at = checkin.get("checkedInAt")
        if not checked_in_at:
            continue
        try:
            peak_hour_counts[int(checked_in_at[11:13])] += 1
        except Exception:
            pass

    peak_hours = [{"hour": hour, "count": peak_hour_counts.get(hour, 0)} for hour in range(24)]

    facility_usage_counter: Counter[str] = Counter()
    facility_occupied_counter: Counter[str] = Counter()
    for seat in seats:
        for equipment in seat.get("equipment", []):
            facility_usage_counter[equipment] += 1
            if seat.get("occupancyStatus") == "occupied":
                facility_occupied_counter[equipment] += 1
    facility_usage = [
        {"equipment": equipment, "total": total, "occupied": facility_occupied_counter.get(equipment, 0)}
        for equipment, total in sorted(facility_usage_counter.items())
    ]

    unmet_demand = []
    for seat in seats:
        if seat.get("occupancyStatus") == "occupied":
            occupied_count = max(1, seat_usage.get(seat.get("id"), 0) + 1)
            unmet_demand.append({"seatId": seat.get("id"), "occupiedCount": occupied_count})
    unmet_demand.sort(key=lambda item: item["occupiedCount"], reverse=True)

    checkout_counts = Counter()
    checkin_counts = Counter()
    used_seats = set()
    seat_id_re = re.compile(r"seat ([A-Za-z0-9._:-]+)")
    for log in logs:
        action = log.get("action")
        timestamp = (log.get("timestamp") or "")[:10]
        if action == "checkin":
            checkin_counts[timestamp] += 1
            match = seat_id_re.search(log.get("detail", ""))
            if match:
                used_seats.add(match.group(1))
        elif action == "checkout":
            checkout_counts[timestamp] += 1
            match = seat_id_re.search(log.get("detail", ""))
            if match:
                used_seats.add(match.group(1))

    zone_stats: dict[str, dict[str, int]] = {}
    floor_stats: dict[str, dict[str, int]] = {}
    for seat in seats:
        zone = seat.get("zoneType") or "unknown"
        floor = str(seat.get("floor", 1))
        zone_entry = zone_stats.setdefault(zone, {"total": 0, "occupied": 0})
        floor_entry = floor_stats.setdefault(floor, {"total": 0, "occupied": 0})
        zone_entry["total"] += 1
        floor_entry["total"] += 1
        if seat.get("occupancyStatus") == "occupied":
            zone_entry["occupied"] += 1
            floor_entry["occupied"] += 1

    return {
        "peakHours": peak_hours,
        "popularSeats": [{"seatId": seat_id, "count": count} for seat_id, count in seat_usage.most_common(8)],
        "facilityUsage": facility_usage,
        "unmetDemand": unmet_demand[:8],
        "turnover": [{"date": date, "count": count} for date, count in sorted(checkout_counts.items())],
        "dailyCheckins": [{"date": date, "count": count} for date, count in sorted(checkin_counts.items())],
        "zoneStats": zone_stats,
        "floorStats": floor_stats,
        "totalCheckins": len(checkins) + sum(checkin_counts.values()),
        "totalCheckouts": sum(checkout_counts.values()),
        "uniqueSeatsUsed": len(used_seats or set(seat_usage.keys())),
    }


@app.get("/api/admin/dashboard")
async def get_dashboard(username: str = Depends(require_admin)):
    """Get occupancy stats per floor and overall."""
    seats = load_seats()

    stats = {"total": len(seats), "available": 0, "occupied": 0, "by_floor": {}}
    for seat in seats:
        floor = seat.get("floor", 1)
        if floor not in stats["by_floor"]:
            stats["by_floor"][floor] = {"total": 0, "available": 0, "occupied": 0}
        stats["by_floor"][floor]["total"] += 1
        if seat.get("occupancyStatus") == "available":
            stats["available"] += 1
            stats["by_floor"][floor]["available"] += 1
        else:
            stats["occupied"] += 1
            stats["by_floor"][floor]["occupied"] += 1

    return {"stats": stats}


@app.get("/api/admin/analytics")
async def get_analytics(username: str = Depends(require_admin)):
    """Return aggregated analytics for the admin analytics tab."""
    return _build_analytics_payload()


@app.get("/api/admin/seats")
async def admin_get_seats(floor: int | None = None, username: str = Depends(require_admin)):
    """Get all seats for admin, optionally filtered by floor."""
    seats = load_seats()
    if floor is not None:
        seats = [s for s in seats if s.get("floor") == floor]
    return {"seats": seats}


@app.put("/api/admin/seats/{seat_id}/status")
async def update_seat_status(seat_id: str, req: SeatStatusUpdate, username: str = Depends(require_admin)):
    """Set an individual seat's occupancy status — stands in for a CV update.

    seat_id refers to an individual seat (a layout.json type=="seat"
    object), not a table — a table may have several independently
    toggleable seats.
    """
    if req.status not in ("available", "occupied"):
        raise HTTPException(400, "status must be 'available' or 'occupied'")

    repository.set_seat_status(seat_id, req.status)
    return {"status": "ok", "seat_id": seat_id, "new_status": req.status}


@app.get("/api/admin/logs")
async def get_logs(limit: int = 50, username: str = Depends(require_admin)):
    """Get recent admin activity logs."""
    return {"logs": repository.recent_logs(limit)}


# ═══════════════════════════════════════════════════════════════════════
# Camera calibration & YOLO occupancy detection
#
# A camera sees a photo in its own pixel grid; the floor plan is a schematic
# in a different space. Calibration links them by hand: per camera, the admin
# draws a box (normalized 0–1) around each seat as it appears in the camera's
# snapshot, tagged with that seat's floor-plan id. Detection then runs YOLO on
# a frame, finds people, and flips each calibrated seat available/occupied by
# geometry. See docs/camera_calibration.md.
# ═══════════════════════════════════════════════════════════════════════

class SeatBox(BaseModel):
    seatId: str
    x: float
    y: float
    w: float
    h: float


class CalibrationSaveRequest(BaseModel):
    seatBoxes: list[SeatBox]


class PersonBox(BaseModel):
    x: float
    y: float
    w: float
    h: float


class DetectRequest(BaseModel):
    # If provided, skip YOLO and use these normalized person boxes directly —
    # the dev/test path that exercises the full chain without the ML stack.
    personBoxes: list[PersonBox] | None = None


@app.get("/api/admin/cameras")
async def list_cameras(floor: int | None = None, username: str = Depends(require_admin)):
    return {"cameras": repository.list_cameras(floor)}


def _ext_for(filename: str | None) -> str:
    ext = (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else "jpg"
    return ext if ext in ("jpg", "jpeg", "png", "webp") else "jpg"


async def _save_camera_image(cam_id: str, file: UploadFile) -> tuple[str, int | None, int | None]:
    """Write an uploaded (or webcam-captured, from the browser's own
    getUserMedia + canvas — same multipart upload either way) image to disk
    under this camera's id and return (relative path, width, height)."""
    filename = f"{cam_id}.{_ext_for(file.filename)}"
    dest = CAMERAS_IMG_DIR / filename
    contents = await file.read()
    dest.write_bytes(contents)

    # Best-effort image dimensions — nothing depends on them (boxes are
    # normalized), so a missing Pillow just leaves them null.
    width = height = None
    try:
        from PIL import Image
        from io import BytesIO
        with Image.open(BytesIO(contents)) as im:
            width, height = im.size
    except Exception:
        pass
    return f"cameras/{filename}", width, height


@app.post("/api/admin/cameras")
async def create_camera(
    file: UploadFile = File(...),
    floor: int = Form(...),
    label: str = Form(""),
    username: str = Depends(require_admin),
):
    """Upload a snapshot from a camera's vantage point and create its record."""
    cam_id = f"CAM-{uuid.uuid4().hex[:8]}"
    image_path, width, height = await _save_camera_image(cam_id, file)

    camera = {
        "id": cam_id,
        "floor": floor,
        "label": label.strip(),
        "image": image_path,
        "imageWidth": width,
        "imageHeight": height,
        "calibratedAt": None,
        "seatBoxes": [],
    }
    repository.add_camera(camera)
    repository.add_log("camera_add", f"Added camera '{camera['label'] or cam_id}'", floor)
    return camera


@app.get("/api/admin/cameras/{cam_id}")
async def get_camera(cam_id: str, username: str = Depends(require_admin)):
    camera = repository.get_camera(cam_id)
    if not camera:
        raise HTTPException(404, "Camera not found")
    return camera


@app.get("/api/admin/cameras/{cam_id}/snapshot")
async def get_camera_snapshot(cam_id: str, username: str = Depends(require_admin)):
    camera = repository.get_camera(cam_id)
    if not camera:
        raise HTTPException(404, "Camera not found")
    path = IMAGES_DIR / camera["image"]
    if not path.exists():
        raise HTTPException(404, "Snapshot image missing")
    return FileResponse(path)


@app.put("/api/admin/cameras/{cam_id}/snapshot")
async def replace_camera_snapshot(cam_id: str, file: UploadFile = File(...), username: str = Depends(require_admin)):
    """Swap in a fresh frame — e.g. a new webcam capture — without touching
    calibration. Seat boxes are normalized to the frame composition, not the
    file, so they keep lining up as long as the camera hasn't moved; this is
    what makes a live "recapture, then re-run detection" loop useful for
    testing instead of re-calibrating every time."""
    cameras = _load_cameras()
    camera = next((c for c in cameras if c["id"] == cam_id), None)
    if not camera:
        raise HTTPException(404, "Camera not found")

    old_image = camera["image"]
    image_path, width, height = await _save_camera_image(cam_id, file)
    if old_image != image_path:
        (IMAGES_DIR / old_image).unlink(missing_ok=True)
    camera["image"] = image_path
    camera["imageWidth"] = width
    camera["imageHeight"] = height
    _save_cameras(cameras)
    add_log("camera_recapture", f"New snapshot for camera '{camera.get('label') or cam_id}'", camera.get("floor"))
    return camera


@app.put("/api/admin/cameras/{cam_id}/calibration")
async def save_calibration(cam_id: str, req: CalibrationSaveRequest, username: str = Depends(require_admin)):
    seat_boxes = [b.model_dump() for b in req.seatBoxes]
    info = repository.save_calibration(cam_id, seat_boxes)  # raises RepositoryError(404) if gone
    repository.add_log(
        "camera_calibrate",
        f"Calibrated {len(req.seatBoxes)} seat(s) on camera '{info['label'] or cam_id}'",
        info["floor"],
    )
    return {"status": "ok", "seatBoxes": info["seatBoxes"]}


@app.delete("/api/admin/cameras/{cam_id}")
async def delete_camera(cam_id: str, username: str = Depends(require_admin)):
    info = repository.delete_camera(cam_id)  # raises RepositoryError(404) if gone
    try:
        (IMAGES_DIR / info["image"]).unlink(missing_ok=True)
    except Exception:
        pass
    repository.add_log("camera_delete", f"Removed camera '{info['label'] or cam_id}'", info["floor"])
    return {"status": "ok"}


@app.post("/api/admin/cameras/{cam_id}/detect")
async def detect_camera(cam_id: str, req: DetectRequest, username: str = Depends(require_admin)):
    """Run occupancy detection for a camera and apply it to the seats.

    With a `personBoxes` body, skips inference (dev/test path). Otherwise runs
    real YOLOv8n on the stored snapshot via ONNX Runtime.
    """
    camera = repository.get_camera(cam_id)
    if not camera:
        raise HTTPException(404, "Camera not found")
    seat_boxes = camera.get("seatBoxes", [])
    if not seat_boxes:
        raise HTTPException(400, "Camera has no calibrated seats yet")

    if req.personBoxes is not None:
        person_boxes = [p.model_dump() for p in req.personBoxes]
    else:
        image_path = IMAGES_DIR / camera["image"]
        if not image_path.exists():
            raise HTTPException(404, "Snapshot image missing")
        try:
            from src.cv.detector import detect_person_boxes
            person_boxes = detect_person_boxes(str(image_path))
        except ImportError:
            raise HTTPException(503, "Detection deps missing. Run `pip install -r requirements.txt`, or send personBoxes to test without them.")
        except FileNotFoundError:
            raise HTTPException(503, "YOLO model missing. Run `python scripts/fetch_model.py`, or send personBoxes to test without it.")
        except Exception as e:
            raise HTTPException(500, f"Detection failed: {e}")

    status_map = compute_seat_occupancy(seat_boxes, person_boxes)
    updated = repository.apply_occupancy(status_map)
    occupied = sum(1 for s in status_map.values() if s == "occupied")
    repository.add_log(
        "cv_detect",
        f"Camera '{camera.get('label') or cam_id}': {len(person_boxes)} person(s), "
        f"{occupied}/{len(status_map)} seats occupied ({updated} changed)",
        camera.get("floor"),
    )
    return {
        "status": "ok",
        "results": status_map,
        "personCount": len(person_boxes),
        "updated": updated,
    }


# ═══════════════════════════════════════════════════════════════════════
# Self check-in — a camera-free alternative (or complement) to CV occupancy
# for schools not comfortable with cameras. A student picks their own chair
# and self-reports "I'm sitting here"; the seat flips occupied. No login —
# a nickname is entirely optional and never verified, it's a courtesy tag
# for a personal point counter, not an identity check. Every check-in has
# an expiry (1h or 2h, student's choice); past that, the student is expected
# to either confirm they're still there (extends it) or check out, and if
# neither happens within CHECKIN_GRACE_MINUTES the seat auto-releases so a
# closed tab can never permanently block it. Points/leaderboard are the
# "help us improve" gamification hook — same nickname convention, so a
# student who never gives one just doesn't participate in it.
# ═══════════════════════════════════════════════════════════════════════

@app.post("/api/checkin")
async def check_in(req: CheckInRequest):
    """Self-report occupying a specific chair. Rejects if that chair is
    already marked occupied by anything (another check-in, CV, or an
    admin) — one source of truth per seat at a time. The claim is an atomic,
    row-locked conditional update in the repository, so two students racing
    for the same chair can never both succeed."""
    if req.durationMinutes not in (60, 120):
        raise HTTPException(400, "durationMinutes must be 60 or 120")
    return repository.checkin(req.seatId, req.durationMinutes, req.nickname)


@app.post("/api/checkin/{checkin_id}/confirm")
async def confirm_checkin(checkin_id: str):
    """"Yes, still here" — resets the expiry clock and gives a small point
    bump for keeping the live data accurate."""
    return repository.confirm_checkin(checkin_id)  # raises RepositoryError(404) if gone


@app.post("/api/checkin/{checkin_id}/checkout")
async def check_out(checkin_id: str):
    """Explicit "I left" — frees the seat immediately and rewards the
    accurate self-report."""
    return repository.checkout(checkin_id)  # raises RepositoryError(404) if gone


@app.get("/api/points/{nickname}")
async def get_points(nickname: str):
    """Look up a nickname's point total — no auth, a nickname is a
    self-chosen courtesy tag, not a login."""
    return {"nickname": nickname, "points": repository.get_points(nickname)}


@app.get("/api/leaderboard")
async def get_leaderboard(limit: int = 10):
    return {"leaderboard": repository.leaderboard(limit)}


# ── Entrypoint ────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
