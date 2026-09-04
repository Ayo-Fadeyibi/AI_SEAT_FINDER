"""
Optimizer component.

Pure filtering logic — NOT a trained model. Takes the LLM's structured intent
plus the seat dataset (whose occupancyStatus is set by the admin panel or YOLO
camera detection) and picks the best match.
"""

import math
from collections import defaultdict


def load_seats(path=None) -> list[dict]:
    """Table-level availability rows (formerly data/seats.json), now served
    from PostgreSQL via the repository. `path` is accepted for backwards
    compatibility with older callers but ignored."""
    from api.repository import query_table_availability
    return query_table_availability()


def _available_capacity(seat: dict) -> int:
    """Free-seat count for group matching.

    Prefers the per-table `availableSeats` field (set once a table has been
    broken into individually-toggleable seats via the floor-plan editor).
    Falls back to the old binary interpretation for any record that
    predates it — e.g. capacity 4 == today's optimizer behavior:
    `seat["capacity"] if seat available else 0`. This fallback is
    deliberately NOT "1 if available else 0" — that would silently break
    existing group matches on any record lacking `availableSeats`.
    """
    if "availableSeats" in seat:
        return seat["availableSeats"]
    return seat["capacity"] if seat.get("occupancyStatus") == "available" else 0


def _bbox_center(bbox: list[float]) -> tuple[float, float]:
    x, y, w, h = bbox
    return x + w / 2, y + h / 2


def _amenity_center(amenity: dict) -> tuple[float, float]:
    return amenity["x"] + amenity["width"] / 2, amenity["y"] + amenity["height"] / 2


def _nearest_amenity_distance(seat: dict, floor_amenities: list[dict], amenity_type: str) -> float | None:
    """Straight-line distance (canvas units) from `seat`'s bbox center to the
    closest amenity of `amenity_type` on the same floor, or None if that
    floor has no amenity of that type — proximity can't be judged against
    something that isn't there."""
    candidates = [a for a in floor_amenities if a.get("amenityType") == amenity_type]
    if not candidates:
        return None
    sx, sy = _bbox_center(seat["bbox"])
    return min(math.hypot(sx - ax, sy - ay) for ax, ay in (_amenity_center(a) for a in candidates))


def _proximity_sort_key(seat: dict, amenities_by_floor: dict[int, list[dict]], near_amenity: str | None, far_amenity: str | None) -> float:
    """Smaller is better. A floor with no instance of the requested amenity
    can't be judged near/far from it at all — such seats sort last in BOTH
    directions, so "far from the toilet" surfaces the farthest seat on a
    floor that actually has one, rather than jumping to an unrelated floor
    that happens to have no toilet on it at all."""
    amenity_type = near_amenity or far_amenity
    if not amenity_type:
        return 0.0
    distance = _nearest_amenity_distance(seat, amenities_by_floor.get(seat.get("floor"), []), amenity_type)
    if distance is None:
        return float("inf")
    return distance if near_amenity else -distance


def _rank_seats(parsed_intent: dict, seats: list[dict], amenities: list[dict] | None) -> tuple[list[dict], list[dict], list[dict], list[dict], int]:
    """Sort every available seat into priority tiers. Shared by recommend()
    and recommend_all() so the two can never disagree about what counts as
    a match.

    Returns (perfect_matches, alt_tier1, alt_tier2, alt_tier3, occupied_count),
    each tier already ordered by proximity if the intent asked for one
    (see _proximity_sort_key) — a no-op when it didn't.
    """
    group_size = parsed_intent["groupSize"]
    zone_type = parsed_intent["zoneType"]
    required_equipment = parsed_intent["requiredEquipment"]
    preferred_floor = parsed_intent.get("floor")
    near_amenity = parsed_intent.get("nearAmenity")
    far_amenity = parsed_intent.get("farAmenity")

    amenities_by_floor: dict[int, list[dict]] = defaultdict(list)
    if near_amenity or far_amenity:
        for a in (amenities or []):
            amenities_by_floor[a.get("floor")].append(a)

    def by_proximity(tier: list[dict]) -> list[dict]:
        if not near_amenity and not far_amenity:
            return tier
        return sorted(tier, key=lambda s: _proximity_sort_key(s, amenities_by_floor, near_amenity, far_amenity))

    perfect_matches = []
    # Priority tiers for alternatives:
    #   tier 1: same zone + capacity OK, missing equipment or wrong floor
    #   tier 2: same zone, capacity insufficient (still in right area)
    #   tier 3: wrong zone, capacity OK
    alt_tier1 = []
    alt_tier2 = []
    alt_tier3 = []
    occupied_count = 0

    for seat in seats:
        available = _available_capacity(seat)
        if available <= 0:
            occupied_count += 1
            continue

        is_zone_ok = seat["zoneType"] == zone_type
        is_capacity_ok = available >= group_size
        is_equipment_ok = all(item in seat["equipment"] for item in required_equipment)
        is_floor_ok = (preferred_floor is None) or (seat.get("floor") == preferred_floor)

        if is_zone_ok and is_capacity_ok and is_equipment_ok and is_floor_ok:
            perfect_matches.append(seat)
        elif is_zone_ok and is_capacity_ok:
            alt_tier1.append(seat)
        elif is_zone_ok and not is_capacity_ok:
            alt_tier2.append(seat)
        elif not is_zone_ok and is_capacity_ok:
            alt_tier3.append(seat)

    return by_proximity(perfect_matches), by_proximity(alt_tier1), by_proximity(alt_tier2), by_proximity(alt_tier3), occupied_count


def recommend_all(parsed_intent: dict, seats: list[dict], amenities: list[dict] | None = None) -> tuple[list[dict], str]:
    """
    Take a structured intent and a seat dataset, return every seat in the
    best-available tier — not just one — so a student can pick whichever
    suits them (e.g. multiple quiet seats with a power outlet all qualify
    equally; there's no reason to hide the other four).

    Returns (seats, match_type) where match_type is one of:
      - "perfect": every returned seat satisfies all criteria
      - "alternative": every returned seat is the closest available fallback
        tier (all share the same tier, so they're equally "alternative")
      - "none": no available seats at all
    """
    perfect_matches, alt_tier1, alt_tier2, alt_tier3, occupied_count = _rank_seats(parsed_intent, seats, amenities)

    if perfect_matches:
        return perfect_matches, "perfect"

    for tier in (alt_tier1, alt_tier2, alt_tier3):
        if tier:
            return tier, "alternative"

    return [], "none"


def recommend(parsed_intent: dict, seats: list[dict], amenities: list[dict] | None = None) -> tuple[dict | None, str]:
    """Single-best-match convenience wrapper around recommend_all() — kept
    for any caller that only wants the top pick."""
    results, match_type = recommend_all(parsed_intent, seats, amenities)
    return (results[0] if results else None), match_type


def get_fallback_reason(match_type: str, reasons: list[str] | None = None) -> str:
    """Generate a human-readable fallback reason."""
    if match_type == "perfect":
        return ""
    if match_type == "none":
        return "all_occupied"
    if reasons:
        return ", ".join(reasons)
    return "partial_match"
