# Database (PostgreSQL)

FindaSpot stores all state in PostgreSQL. The former flat-file store under
`data/*.json` is kept only as the **seed source** for the initial migration and
as a reference snapshot — the running app never reads or writes it.

## Quick start

`python main.py` (or `bash start.sh`) does all of this automatically: it brings
up the database container, applies migrations, and seeds from `data/*.json` on
first run. To do it by hand:

```bash
docker compose up -d db          # start PostgreSQL 16 (named volume keeps data)
alembic upgrade head             # create tables + the v_table_availability view
python scripts/migrate_json_to_db.py   # load data/*.json into the DB (idempotent)
```

Requirements: Docker Desktop (or a Postgres you point `DATABASE_URL` at) and the
Python deps (`pip install -r requirements.txt`).

## Configuration

The backend reads `DATABASE_URL`; copy `.env.example` to `.env` to override.
The default matches `docker-compose.yml`:

```
DATABASE_URL=postgresql+psycopg://findaspot:findaspot@localhost:5432/findaspot
```

## Schema

Normalized tables mirror the old JSON files. `layout.json`'s flat object list is
split into `floors` / `tables` / `seats` / `amenities`; the per-object array
index is preserved in an `ordinal` column so the layout editor round-trips in the
original order. Blob-shaped config (a table's `equipment`, a camera's
`seat_boxes`) is stored as JSONB.

| Table | Was |
|---|---|
| `floors`, `tables`, `seats`, `amenities` | `layout.json` objects |
| `checkins` | `checkins.json` |
| `points` | `points.json` |
| `admin_users` | `admin_users.json` |
| `admin_logs` | `admin_logs.json` |
| `cameras` | `camera_calibration.json` |

Table-level availability (the old `data/seats.json`, what `/api/seats` and the
recommender consume) is **not** a table — it is the `v_table_availability` SQL
view, which reproduces the former `_derive_seats_from_layout` projection: one row
per table with ≥1 seat, `capacity` = child count, `availableSeats` = free
children, `occupancyStatus` = available if any child is free.

## Data access

All persistence lives in [`api/repository.py`](../api/repository.py); endpoints
in `api/server.py` call it and never touch SQL directly. The check-in / checkout
/ auto-release / occupancy mutations run in a single row-locked transaction, so
concurrent writers can't clobber each other (a race for the same chair yields
exactly one success and one `409`).

## Migrations

Schema changes are Alembic revisions in `alembic/versions/`:

```bash
alembic revision -m "describe change"   # autogenerate: add --autogenerate
alembic upgrade head                    # apply
alembic downgrade -1                    # roll back one
```

## Resetting

```bash
docker compose down -v            # stop DB and delete all data
docker compose up -d db
alembic upgrade head
python scripts/migrate_json_to_db.py
```

Re-running the migration script alone also resets to the `data/*.json` seed — it
truncates every table before loading.
```
