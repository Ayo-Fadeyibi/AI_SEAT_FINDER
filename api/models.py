"""
SQLAlchemy 2.0 ORM models for the FindaSpot store.

Mirrors the former data/*.json files:
  layout.json (objects)  -> Floor / Table / Seat / Amenity
  checkins.json          -> CheckIn
  points.json            -> Points
  admin_users.json       -> AdminUser
  admin_logs.json        -> AdminLog
  camera_calibration.json-> Camera (seat_boxes kept as JSONB)

Table-level availability (the former seats.json) is NOT a table — it is the
`v_table_availability` SQL view created in the initial Alembic migration and
queried by repository.query_table_availability().
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


# ── Geometry mixin: shared canvas coordinates for tables/seats/amenities ──
class _Geometry:
    # Index of this object within the layout's flat `objects` array. Preserved
    # so layout GET and the seats view reproduce the exact original ordering
    # (the JSON store was order-sensitive; the finder/editor render in order).
    ordinal: Mapped[int] = mapped_column(Integer, default=0, index=True)
    # Authored capacity as saved by the layout editor, preserved verbatim for
    # layout GET round-tripping (tables: authored value — may differ from child
    # count; seats: 1; amenities: 0). NOTE: table-level availability capacity is
    # computed from child seat count in v_table_availability, not from this.
    capacity: Mapped[int] = mapped_column(Integer, default=1)
    x: Mapped[float] = mapped_column(Float, default=0.0)
    y: Mapped[float] = mapped_column(Float, default=0.0)
    width: Mapped[float] = mapped_column(Float, default=0.0)
    height: Mapped[float] = mapped_column(Float, default=0.0)
    rotation: Mapped[float] = mapped_column(Float, default=0.0)
    color: Mapped[str] = mapped_column(Text, default="")


class Floor(Base):
    __tablename__ = "floors"
    number: Mapped[int] = mapped_column(Integer, primary_key=True)
    label: Mapped[str] = mapped_column(Text, default="")


class Table(_Geometry, Base):
    __tablename__ = "tables"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    floor: Mapped[int] = mapped_column(Integer, ForeignKey("floors.number", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(Text, default="")
    location: Mapped[str] = mapped_column(Text, default="")
    zone_type: Mapped[str] = mapped_column(Text, default="quiet")
    equipment: Mapped[list] = mapped_column(JSONB, default=list)

    seats: Mapped[list["Seat"]] = relationship(
        back_populates="table", cascade="all, delete-orphan"
    )


class Seat(_Geometry, Base):
    __tablename__ = "seats"
    __table_args__ = (
        CheckConstraint(
            "occupancy_status IN ('available', 'occupied')",
            name="ck_seats_occupancy_status",
        ),
    )
    id: Mapped[str] = mapped_column(String, primary_key=True)
    table_id: Mapped[str] = mapped_column(
        String, ForeignKey("tables.id", ondelete="CASCADE"), index=True
    )
    floor: Mapped[int] = mapped_column(Integer)
    occupancy_status: Mapped[str] = mapped_column(Text, default="available")

    table: Mapped["Table"] = relationship(back_populates="seats")


class Amenity(_Geometry, Base):
    __tablename__ = "amenities"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    floor: Mapped[int] = mapped_column(Integer, ForeignKey("floors.number", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(Text, default="")
    amenity_type: Mapped[str | None] = mapped_column(Text, nullable=True)


class CheckIn(Base):
    __tablename__ = "checkins"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    seat_id: Mapped[str] = mapped_column(String, ForeignKey("seats.id", ondelete="CASCADE"))
    nickname: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_minutes: Mapped[int] = mapped_column(Integer)
    # Naive local timestamps, matching the app's datetime.now().isoformat()
    # usage — keeps stored/returned strings byte-identical to the JSON store.
    checked_in_at: Mapped[datetime] = mapped_column(DateTime)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)


class Points(Base):
    __tablename__ = "points"
    nickname: Mapped[str] = mapped_column(Text, primary_key=True)
    points: Mapped[int] = mapped_column(Integer, default=0)


class AdminUser(Base):
    __tablename__ = "admin_users"
    username: Mapped[str] = mapped_column(Text, primary_key=True)
    salt: Mapped[str] = mapped_column(Text)
    password_hash: Mapped[str] = mapped_column(Text)


class AdminLog(Base):
    __tablename__ = "admin_logs"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    action: Mapped[str] = mapped_column(Text)
    detail: Mapped[str] = mapped_column(Text)
    floor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Naive local time, set in repository.add_log() (mirrors the old add_log).
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)


class Camera(Base):
    __tablename__ = "cameras"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    floor: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(Text, default="")
    image: Mapped[str] = mapped_column(Text, default="")
    image_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    image_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    calibrated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    seat_boxes: Mapped[list] = mapped_column(JSONB, default=list)
