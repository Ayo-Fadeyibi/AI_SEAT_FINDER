# FindaSpot

Real-time computer vision system that detects library seat availability using
object detection, built during UQ's Startup China AI program at Dalian
Neusoft University of Information.

An AI-assisted library seat finder. A student describes what they need in
plain language ("a quiet seat with a power outlet", "somewhere for four
people to work together on floor 2") and FindaSpot parses that into
structured criteria, matches it against the current seat dataset, and
recommends the best available seat. It's a recommender, not a booking
system — most library seats can't be physically reserved, so the app tells
you where to go rather than holding a spot for you.

An admin panel lets library staff manage that seat dataset: build the floor
plan by hand, mark seats available/occupied, calibrate cameras so occupancy
can be detected automatically with YOLO, and review recent activity.

## How it works

```text
                     ┌─────────────────────┐
  "quiet seat with   │   Intent Parser      │   LLM (or keyword fallback)
   power outlet,     │   src/intent_parser  │   text → structured intent
   floor 2"    ─────▶│                      │
                     └──────────┬───────────┘
                                │ {zoneType, groupSize,
                                │  requiredEquipment, floor}
                                ▼
                     ┌──────────────────────┐       ┌───────────────────┐
                     │   Optimizer           │◀──────│  data/seats.json   │
                     │   src/optimizer       │       │  (zone, capacity,  │
                     │   matches intent       │       │  equipment, floor, │
                     │   against seats        │       │  occupancy status) │
                     └──────────┬───────────┘       └─────────▲──────────┘
                                │                              │
                                ▼                              │ toggled by
                      Recommended seat                          staff via the
                      (perfect / alternative /                  Admin panel
                       none, with a reason)                     │
                                                        ┌────────┴──────────┐
                                                        │   Admin panel      │
                                                        │   /admin           │
                                                        │   seat status,     │
                                                        │   floor layout,    │
                                                        │   cameras, logs    │
                                                        └────────────────────┘
```

- **Intent Parser** (`src/intent_parser/parser.py`) — sends the query to an
  LLM (Xiaomi MiMo, OpenAI-compatible API) with a strict JSON-output prompt,
  and falls back to keyword matching if the API call fails. Extracts zone
  type (quiet/collaborative), group size, required equipment
  (power outlet/projector), and an optional floor preference.
- **Optimizer** (`src/optimizer/optimizer.py`) — pure filtering logic, no
  ML. Finds a seat that satisfies every criterion ("perfect"), or falls back
  through priority tiers (right zone but missing equipment/floor → wrong
  capacity → wrong zone) to the closest "alternative", or reports "none" if
  nothing is available.
- **Seat occupancy** is a plain available/occupied flag per seat. Staff can
  set it by hand in the Admin panel, or have it detected automatically: an
  admin calibrates a camera once (drawing a box around each seat as it appears
  in the camera's own photo — see [docs/camera_calibration.md](docs/camera_calibration.md)),
  after which a YOLO person-detector reads each frame and flips seats
  occupied/free by simple geometry. The system intentionally does **not** track
  which individual is sitting where, only whether each seat is free. (YOLO
  replaces an earlier vision-LLM occupancy prototype in
  `src/occupancy_detector/`, which is no longer used by the web app.)
- **API** (`api/server.py`) — FastAPI server exposing the finder endpoints
  publicly and the admin endpoints behind login.
- **Frontend** (`frontend/`) — a Vite + React + Tailwind app with three
  routes: `/` (a landing page that splits into student/staff), `/finder`
  (the recommender, no login), and `/admin` (the staff panel, login
  required).

## Project layout

```text
main.py                  Entrypoint — web app (default), CLI REPL, or auto-demo
start.sh                 One-command setup + launch for both servers
api/server.py            FastAPI backend (finder + admin API)
src/intent_parser/       Natural-language query → structured intent
src/optimizer/           Intent + seat data → recommendation
src/cv/                   YOLO person-detection + seat-occupancy geometry
src/utils/                Config, i18n strings, output formatting
data/seats.json           Live seat dataset (source of truth for occupancy)
data/layout.json          Saved floor-plan object layout (from the admin panel)
data/camera_calibration.json  Cameras + per-seat boxes in camera-image space
data/images/cameras/      Uploaded camera snapshots
data/admin_users.json     Admin account(s) (hashed passwords)
data/admin_logs.json      Admin activity log
scripts/create_admin.py   CLI to create/reset the admin login (no public signup)
frontend/src/app/Landing.tsx Root landing page (student vs. staff)
frontend/src/app/App.tsx  Finder UI
frontend/src/app/Admin.tsx Admin panel UI
frontend/src/app/api.ts   Typed API client shared by both
```

## Running it

**Requirements:** Python 3.10+, Node.js 18+.

The simplest way — installs dependencies on first run, then starts both
servers:

```bash
bash start.sh
```

Or, equivalently, via the Python entrypoint (does the same thing once
dependencies are installed):

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cd frontend && npm install && cd ..
.venv/bin/python main.py
```

Either way, once both servers are up:

- Landing page: `http://localhost:5173/` (choose student or staff)
- Finder directly: `http://localhost:5173/finder`
- Admin panel: `http://localhost:5173/admin` — see [Admin panel](#admin-panel)
  below to create the login before you can get in
- API directly: `http://localhost:8000/api/`

To run the backend and frontend as separate processes (useful for
debugging one independently):

```bash
.venv/bin/python api/server.py     # backend on :8000
cd frontend && npm run dev          # frontend on :5173
```

There's also a CLI mode that doesn't need the frontend at all — useful for
poking at the intent parser/optimizer directly:

```bash
.venv/bin/python main.py --repl     # interactive prompt, zh/en toggle
.venv/bin/python main.py --demo     # runs a few canned queries automatically
```

## Configuration

The LLM API key ships pre-configured (lightly obfuscated, not a real
secret) for out-of-the-box use. To use your own:

```bash
export FINDASPOT_API_KEY=your-key
export FINDASPOT_LLM_BASE_URL=https://your-endpoint/v1   # optional
export FINDASPOT_LLM_MODEL=your-model                     # optional
```

If the LLM call fails for any reason (bad key, network, rate limit), the
intent parser transparently falls back to keyword matching — the app keeps
working, just with less nuanced understanding of the query.

## Admin panel

There's no public signup — the admin login is a single shared credential,
provisioned locally (shell access required), not over HTTP:

```bash
.venv/bin/python scripts/create_admin.py
```

Run it once to create the account; run it again any time to reset the
password. Then log in at `/admin`. Sessions are bearer tokens held in
server memory, so they don't survive a backend restart — you'll just need
to log in again.

- **Dashboard** — occupancy stats, overall and per floor.
- **Seats** — toggle any seat between available/occupied by hand (a manual
  stand-in for, or override of, camera detection).
- **Layout** — build the floor plan by hand: add floors, then tables and
  seats, drag them into place, add amenities (toilets, exits, …). Saving
  regenerates the live seat dataset from every table that has seats.
- **Cameras** — calibrate cameras for automatic occupancy: upload a snapshot
  from a camera's vantage point, then draw a box around each seat as it
  appears in that photo, linking it to the seat in the floor plan. Once
  calibrated, YOLO person-detection sets each seat's status from the camera
  frame. See [docs/camera_calibration.md](docs/camera_calibration.md).
- **Activity** — a log of recent admin actions (logins, seat updates,
  layout saves, calibration, detection runs).

## Notes

- `tests/`, `dify/config/`, `langflow/flows/` are placeholder directories
  from the original project scaffold and are currently empty.
- `docs/intent_contract.md` documents the data contract between the intent
  parser and optimizer in more detail.
