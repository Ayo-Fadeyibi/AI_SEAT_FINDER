"""
Tests for the PostgreSQL-backed data layer.

Requires a running database (docker compose up -d db) with the schema applied
(alembic upgrade head). Each test re-seeds from data/*.json for isolation.
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api import repository
from api.db import session_scope
from api.models import CheckIn, Seat
from api.server import app, _sessions
from scripts.migrate_json_to_db import main as seed_db

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def fresh_db():
    """Reset the DB to the data/*.json seed before every test."""
    seed_db()
    yield


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def admin_headers():
    _sessions["test-token"] = "tester"
    return {"Authorization": "Bearer test-token"}


def _first_available_chair(client) -> dict:
    chairs = client.get("/api/chairs").json()["chairs"]
    return next(c for c in chairs if c["occupancyStatus"] == "available")


def test_view_matches_legacy_derivation():
    """v_table_availability must reproduce the old data/seats.json exactly."""
    got = repository.query_table_availability()
    expected = json.loads((ROOT / "data" / "seats.json").read_text())["seats"]
    assert got == expected


def test_seats_endpoint_parity(client):
    resp = client.get("/api/seats").json()["seats"]
    expected = json.loads((ROOT / "data" / "seats.json").read_text())["seats"]
    assert resp == expected


def test_layout_roundtrip_is_byte_identical(client, admin_headers):
    got = client.get("/api/admin/layout", headers=admin_headers).json()
    original = json.loads((ROOT / "data" / "layout.json").read_text())
    assert got["objects"] == original["objects"]
    assert got["floors"] == original["floors"]


def test_checkin_occupies_then_checkout_frees(client):
    chair = _first_available_chair(client)
    r = client.post("/api/checkin", json={"seatId": chair["id"], "durationMinutes": 60, "nickname": "alice"})
    assert r.status_code == 200
    cid = r.json()["checkinId"]

    after = client.get(f"/api/chairs?tableId={chair['tableId']}").json()["chairs"]
    assert next(c for c in after if c["id"] == chair["id"])["occupancyStatus"] == "occupied"

    r2 = client.post(f"/api/checkin/{cid}/checkout")
    assert r2.status_code == 200
    after2 = client.get(f"/api/chairs?tableId={chair['tableId']}").json()["chairs"]
    assert next(c for c in after2 if c["id"] == chair["id"])["occupancyStatus"] == "available"


def test_double_checkin_is_conflict(client):
    chair = _first_available_chair(client)
    assert client.post("/api/checkin", json={"seatId": chair["id"], "durationMinutes": 60}).status_code == 200
    r = client.post("/api/checkin", json={"seatId": chair["id"], "durationMinutes": 60})
    assert r.status_code == 409
    assert "already marked occupied" in r.json()["detail"]


def test_checkin_unknown_seat_404(client):
    r = client.post("/api/checkin", json={"seatId": "does-not-exist", "durationMinutes": 60})
    assert r.status_code == 404


def test_invalid_duration_rejected(client):
    chair = _first_available_chair(client)
    r = client.post("/api/checkin", json={"seatId": chair["id"], "durationMinutes": 45})
    assert r.status_code == 400


def test_auto_release_frees_expired_checkin(client):
    chair = _first_available_chair(client)
    cid = client.post("/api/checkin", json={"seatId": chair["id"], "durationMinutes": 60}).json()["checkinId"]

    # Fast-forward: push expiry well past the grace window.
    with session_scope() as s:
        c = s.get(CheckIn, cid)
        c.expires_at = datetime.now() - timedelta(minutes=repository.CHECKIN_GRACE_MINUTES + 5)

    released = repository.release_expired_checkins()
    assert released == 1
    with session_scope() as s:
        assert s.get(CheckIn, cid) is None
        assert s.get(Seat, chair["id"]).occupancy_status == "available"


def test_points_awarded_and_leaderboard(client):
    chair = _first_available_chair(client)
    r = client.post("/api/checkin", json={"seatId": chair["id"], "durationMinutes": 60, "nickname": "bob"})
    assert r.json()["points"] == 1
    assert client.get("/api/points/bob").json()["points"] == 1
    board = client.get("/api/leaderboard").json()["leaderboard"]
    assert {"nickname": "bob", "points": 1} in board


def test_admin_seat_toggle_and_404(client, admin_headers):
    chair = _first_available_chair(client)
    r = client.put(f"/api/admin/seats/{chair['id']}/status", json={"status": "occupied"}, headers=admin_headers)
    assert r.status_code == 200
    assert client.put("/api/admin/seats/NOPE/status", json={"status": "occupied"}, headers=admin_headers).status_code == 404
