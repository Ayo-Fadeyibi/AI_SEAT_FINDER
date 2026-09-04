"""initial schema: tables + v_table_availability view

Revision ID: 0545242ef78a
Revises:
Create Date: 2026-07-16

Baseline migration. Creates every table from api.models.Base.metadata, then
the v_table_availability view that reproduces the former
_derive_seats_from_layout() projection (the old data/seats.json).
"""

from alembic import op

from api.models import Base

revision = "0545242ef78a"
down_revision = None
branch_labels = None
depends_on = None


# Reproduces api/server.py::_derive_seats_from_layout exactly:
#   - one row per table that has >= 1 child seat (INNER JOIN drops empty tables)
#   - capacity = child seat count; availableSeats = count of 'available' children
#   - occupancyStatus = 'available' if any child free, else 'occupied'
#   - name/location fall back to language-specific defaults when blank
#   - bbox = [trunc(x), trunc(y), trunc(width), trunc(height)] (int() truncation)
#   - ordered by the table's ordinal so output matches the old seats.json order
_CREATE_VIEW = """
CREATE VIEW v_table_availability AS
SELECT
    t.id                                                       AS id,
    COALESCE(NULLIF(t.name, ''), '桌')                          AS name_zh,
    COALESCE(NULLIF(t.name, ''), 'Table')                      AS name_en,
    COALESCE(NULLIF(t.zone_type, ''), 'quiet')                 AS zone_type,
    COUNT(s.id)                                                AS capacity,
    COUNT(s.id) FILTER (WHERE s.occupancy_status = 'available') AS available_seats,
    t.equipment                                                AS equipment,
    t.floor                                                    AS floor,
    COALESCE(NULLIF(t.location, ''), 'Floor ' || t.floor)      AS location_zh,
    COALESCE(NULLIF(t.location, ''), 'Floor ' || t.floor)      AS location_en,
    CASE
        WHEN COUNT(s.id) FILTER (WHERE s.occupancy_status = 'available') > 0
        THEN 'available' ELSE 'occupied'
    END                                                        AS occupancy_status,
    jsonb_build_array(
        trunc(t.x)::int, trunc(t.y)::int,
        trunc(t.width)::int, trunc(t.height)::int
    )                                                          AS bbox,
    t.ordinal                                                  AS ordinal
FROM tables t
JOIN seats s ON s.table_id = t.id
GROUP BY t.id
ORDER BY t.ordinal;
"""


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)
    op.execute(_CREATE_VIEW)


def downgrade() -> None:
    bind = op.get_bind()
    op.execute("DROP VIEW IF EXISTS v_table_availability")
    Base.metadata.drop_all(bind=bind)
