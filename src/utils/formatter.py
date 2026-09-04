"""
Formats a seat (or None) into a human-readable string for CLI output.

Supports bilingual output with visual bounding box hints.
"""

from src.utils.language import t, get_lang


EQUIPMENT_LABELS = {
    "zh": {"power_outlet": "充电口", "projector": "投影仪"},
    "en": {"power_outlet": "Power Outlet", "projector": "Projector"},
}


def _translate_equipment(equip_list: list[str]) -> str:
    """Translate equipment names to current language."""
    lang = get_lang()
    if not equip_list:
        return t("no_equipment")
    labels = EQUIPMENT_LABELS.get(lang, EQUIPMENT_LABELS["en"])
    return ", ".join(labels.get(e, e) for e in equip_list)


def _translate_zone(zone_type: str) -> str:
    """Translate zone type to current language."""
    zone_map = {"quiet": "quiet_zone", "collaborative": "collaborative_zone"}
    return t(zone_map.get(zone_type, zone_type))


def _translate_location(seat: dict) -> str:
    """Get localized location string."""
    lang = get_lang()
    return seat.get(f"location_{lang}", seat.get("location", ""))


def _translate_seat_name(seat: dict) -> str:
    """Get localized seat name."""
    lang = get_lang()
    return seat.get(f"name_{lang}", seat.get("id"))


def format_seat_output(seat: dict | None, match_type: str = "perfect") -> str:
    """
    Format a seat recommendation into a readable string.

    Args:
        seat: The seat dict (or None)
        match_type: "perfect", "alternative", or "none"
    """
    if seat is None:
        return t("empty_msg")

    name = _translate_seat_name(seat)
    zone_text = _translate_zone(seat["zoneType"])
    status_text = t("available") if seat["occupancyStatus"] == "available" else t("occupied")
    equipment_text = _translate_equipment(seat["equipment"])
    location_text = _translate_location(seat)

    output = t("seat_info").format(
        name=name,
        id=seat["id"],
        zone=zone_text,
        floor=seat.get("floor", "-"),
        cap=seat["capacity"],
        equipment=equipment_text,
        location=location_text,
        status=status_text,
    )

    # Add visual bounding box hint (useful for frontend rendering)
    if "bbox" in seat:
        output += "\n" + t("visual_hint").format(bbox=seat["bbox"])

    return output


def format_intent(intent: dict) -> str:
    """Format a parsed intent for display."""
    lines = [t("parsed_intent")]
    lines.append(t("intent_zone", zone=_translate_zone(intent["zoneType"])))
    lines.append(t("intent_group", size=intent["groupSize"]))

    floor = intent.get("floor")
    if floor is not None:
        lines.append(f"  Floor: {floor}F")

    equip = _translate_equipment(intent["requiredEquipment"])
    lines.append(t("intent_equip", equip=equip))

    access = intent.get("accessibilityNeeds") or "-"
    lines.append(t("intent_access", access=access))

    return "\n".join(lines)
