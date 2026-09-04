"""
Intent parser component.

Uses an LLM (via OpenAI-compatible API) to turn a student's natural-language
study request into a structured intent dict.

The LLM only understands TEXT — it never sees images or occupancy data.
CV and LLM are completely independent; they merge only at the optimizer.
"""

import json
import re

from openai import OpenAI

from src.utils.config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL

# Mirrors frontend/src/app/api.ts's AmenityType union — keep in sync.
_VALID_AMENITY_TYPES = {
    "toilet", "exit", "elevator", "stairs", "water_fountain",
    "printer", "entrance", "help_desk", "other",
}

# ── System prompt (bilingual) ────────────────────────────────────────
_SYSTEM_PROMPT = """You are a library seat intent parser. Convert natural language into a JSON object.

You MUST reply with ONLY a valid JSON object. No markdown, no explanation, no code blocks.

The JSON must have exactly these fields and values:

{
  "zoneType": "<one of: quiet, collaborative>",
  "groupSize": <positive integer>,
  "requiredEquipment": [<one or more of: "power_outlet", "projector">],
  "accessibilityNeeds": <string or null>,
  "floor": <integer or null>,
  "nearAmenity": "<one of: toilet, exit, elevator, stairs, water_fountain, printer, entrance, help_desk or null>",
  "farAmenity": "<one of: toilet, exit, elevator, stairs, water_fountain, printer, entrance, help_desk or null>"
}

STRICT MAPPING RULES:
- Any mention of quiet/solo/private/individual/安静区/独立学习/学习/自习 → zoneType: "quiet"
- Any mention of group/team/collaborative/小组/协作/讨论/一起/公共/合作 → zoneType: "collaborative"
- If no zone mentioned → default "quiet"
- COUNT PEOPLE MENTIONED carefully:
  * "小组合作" / "小组讨论" / "团队" / "team" / "group" → groupSize: 4 (default for group work)
  * "四人" / "4人" / "four" → groupSize: 4
  * "三人" / "3人" / "three" → groupSize: 3
  * "两人" / "2人" / "two" / "双人" → groupSize: 2
  * Explicit single person: "一个人" / "独立" / "solo" / "alone" → groupSize: 1
  * If group activity implied but no number: groupSize: 4
  * If no mention at all → groupSize: 1
- Any mention of charging/power/outlet/充电/插座/充电口/charger → requiredEquipment must include "power_outlet"
- Any mention of projector/投影 → requiredEquipment must include "projector"
- If no equipment mentioned → requiredEquipment: []
- Floor: use if explicitly mentioned (e.g. "二楼" → 2, "3楼" → 3). Otherwise null.
- Proximity to an amenity (a map marker, NOT a seat feature — separate from requiredEquipment):
  * amenity keywords: toilet/bathroom/restroom/washroom/WC/洗手间/卫生间/厕所 → "toilet";
    exit/出口 → "exit"; elevator/lift/电梯 → "elevator"; stairs/staircase/楼梯 → "stairs";
    water fountain/drinking water/饮水机/饮水 → "water_fountain"; printer/打印机/打印 → "printer";
    entrance/entry/入口/进口 → "entrance"; help desk/information desk/service desk/服务台/咨询台 → "help_desk"
  * "close to"/"near"/"next to"/"by"/"beside"/"close by"/靠近/附近/旁边/离...近 + an amenity keyword →
    set nearAmenity to that amenity's value
  * "far from"/"away from"/"not near"/远离/离...远/避开 + an amenity keyword →
    set farAmenity to that amenity's value
  * If no proximity phrase + amenity is mentioned → both null
  * A query can only prefer near OR far for a given amenity, never both

IMPORTANT: The equipment values MUST be exactly "power_outlet" or "projector", NOT "charging port" or "charger".

Example input: "我想要安静区、适合独立学习、有充电口的座位"
Example output: {"zoneType": "quiet", "groupSize": 1, "requiredEquipment": ["power_outlet"], "accessibilityNeeds": null, "floor": null, "nearAmenity": null, "farAmenity": null}

Example input: "帮我找个小组合作的地方"
Example output: {"zoneType": "collaborative", "groupSize": 4, "requiredEquipment": [], "accessibilityNeeds": null, "floor": null, "nearAmenity": null, "farAmenity": null}

Example input: "a quiet seat close to the stairs"
Example output: {"zoneType": "quiet", "groupSize": 1, "requiredEquipment": [], "accessibilityNeeds": null, "floor": null, "nearAmenity": "stairs", "farAmenity": null}

Example input: "找个远离洗手间的安静座位"
Example output: {"zoneType": "quiet", "groupSize": 1, "requiredEquipment": [], "accessibilityNeeds": null, "floor": null, "nearAmenity": null, "farAmenity": "toilet"}"""

_client = None

# ── Equipment name normalization ─────────────────────────────────────
_EQUIP_ALIASES = {
    "charging port": "power_outlet",
    "charger": "power_outlet",
    "power": "power_outlet",
    "outlet": "power_outlet",
    "power outlet": "power_outlet",
    "socket": "power_outlet",
    "usb": "power_outlet",
    "charging": "power_outlet",
    "投影仪": "projector",
    "充电口": "power_outlet",
    "插座": "power_outlet",
}

_VALID_EQUIPMENT = {"power_outlet", "projector"}


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
    return _client


def _normalize_equipment(equip_list: list) -> list[str]:
    """Normalize equipment names to canonical form."""
    result = []
    for item in equip_list:
        if not isinstance(item, str):
            continue
        normalized = _EQUIP_ALIASES.get(item.lower().strip(), item)
        if normalized in _VALID_EQUIPMENT and normalized not in result:
            result.append(normalized)
    return result


# amenity_type -> keywords that identify it in either language
_AMENITY_KEYWORDS = {
    "toilet": ("toilet", "bathroom", "restroom", "washroom", "wc", "洗手间", "卫生间", "厕所"),
    "exit": ("exit", "出口"),
    "elevator": ("elevator", "lift", "电梯"),
    "stairs": ("stairs", "staircase", "楼梯"),
    "water_fountain": ("water fountain", "drinking water", "饮水机", "饮水"),
    "printer": ("printer", "printing", "打印机", "打印"),
    "entrance": ("entrance", "entry", "入口", "进口"),
    "help_desk": ("help desk", "information desk", "service desk", "服务台", "咨询台"),
}
_NEAR_KEYWORDS = ("close to", "near", "next to", "beside", "close by", "靠近", "附近", "旁边", "离")
_FAR_KEYWORDS = ("far from", "away from", "not near", "远离", "避开")


def _detect_amenity_proximity(text: str) -> tuple[str | None, str | None]:
    """Keyword-based near/far-amenity detection, shared by the LLM validation
    path (as a fallback if the model omits the fields) and _fallback_parse."""
    amenity_type = None
    for a_type, keywords in _AMENITY_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            amenity_type = a_type
            break
    if amenity_type is None:
        return None, None

    is_far = any(kw in text for kw in _FAR_KEYWORDS)
    is_near = any(kw in text for kw in _NEAR_KEYWORDS)
    if is_far:
        return None, amenity_type
    if is_near:
        return amenity_type, None
    return None, None


def _fallback_parse(query: str) -> dict:
    """Keyword-based fallback when LLM is unavailable."""
    text = query.lower()
    zone_type = "collaborative" if any(
        kw in text for kw in (
            "group", "小组", "collaborative", "公共", "common", "协作", "team",
            "讨论", "一起", "合作", "study together",
        )
    ) else "quiet"

    # Group size detection
    group_size = 1
    if zone_type == "collaborative":
        # Default to 4 for group activities
        group_size = 4
    for token in ("4", "four", "四"):
        if token in text:
            group_size = 4
            break
    for token in ("3", "three", "三"):
        if token in text:
            group_size = 3
            break
    for token in ("2", "two", "二", "两", "双"):
        if token in text:
            group_size = 2
            break
    for token in ("1", "one", "一", "一个人", "独立", "solo"):
        if token in text:
            group_size = 1
            break

    required = []
    if any(kw in text for kw in ("power", "充电", "outlet", "插座", "charging")):
        required.append("power_outlet")
    if "projector" in text or "投影" in text:
        required.append("projector")

    # Floor detection
    floor = None
    import re as _re
    floor_match = _re.search(r"(\d)\s*(?:楼|层|F|floor)", text)
    if floor_match:
        floor = int(floor_match.group(1))
    elif "一楼" in text or "1楼" in text or "1层" in text:
        floor = 1
    elif "二楼" in text or "2楼" in text or "2层" in text:
        floor = 2
    elif "三楼" in text or "3楼" in text or "3层" in text:
        floor = 3

    near_amenity, far_amenity = _detect_amenity_proximity(text)

    return {
        "zoneType": zone_type,
        "groupSize": group_size,
        "requiredEquipment": required,
        "accessibilityNeeds": None,
        "floor": floor,
        "nearAmenity": near_amenity,
        "farAmenity": far_amenity,
    }


def _extract_json(text: str) -> dict:
    """Extract JSON from LLM response, handling markdown code blocks."""
    if not text or not text.strip():
        raise ValueError("Empty response")
    # Try to find JSON in code blocks
    match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if match:
        text = match.group(1)
    text = text.strip()
    return json.loads(text)


def parse(query: str) -> dict:
    """
    Take a natural language query and return a structured intent dict.

    Tries LLM first; falls back to keyword matching if the API call fails.
    """
    try:
        client = _get_client()
        response = client.chat.completions.create(
            model=LLM_MODEL,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": query},
            ],
            temperature=0,
            max_tokens=4096,
        )
        msg = response.choices[0].message
        content = msg.content

        # Reasoning models may put output in reasoning_content with empty content
        if not content or not content.strip():
            reasoning = getattr(msg, "reasoning_content", None)
            if reasoning:
                # Try to extract JSON from reasoning content
                json_match = re.search(r"\{[^{}]*\}", reasoning, re.DOTALL)
                if json_match:
                    content = json_match.group()
                else:
                    content = reasoning

        intent = _extract_json(content)

        # Validate required keys
        intent.setdefault("zoneType", "quiet")
        intent.setdefault("groupSize", 1)
        intent.setdefault("requiredEquipment", [])
        intent.setdefault("accessibilityNeeds", None)
        intent.setdefault("floor", None)
        intent.setdefault("nearAmenity", None)
        intent.setdefault("farAmenity", None)

        # Enforce allowed values
        if intent["zoneType"] not in ("quiet", "collaborative"):
            intent["zoneType"] = "quiet"
        if not isinstance(intent["groupSize"], int) or intent["groupSize"] < 1:
            intent["groupSize"] = 1
        if intent["floor"] is not None:
            if not isinstance(intent["floor"], int) or intent["floor"] < 1:
                intent["floor"] = None
        if intent["nearAmenity"] not in _VALID_AMENITY_TYPES:
            intent["nearAmenity"] = None
        if intent["farAmenity"] not in _VALID_AMENITY_TYPES:
            intent["farAmenity"] = None
        if intent["nearAmenity"] and intent["farAmenity"]:
            # A query can't sensibly ask for both at once — keep whichever
            # the model set first and drop the other rather than guess.
            intent["farAmenity"] = None

        # The model sometimes drops these two newer fields even after the
        # setdefault above overwrote them with an unrelated truthy value, or
        # just doesn't pick up on an explicit proximity phrase — keyword
        # detection as a safety net costs nothing when it agrees, and
        # recovers the common case when it doesn't.
        if intent["nearAmenity"] is None and intent["farAmenity"] is None:
            near_kw, far_kw = _detect_amenity_proximity(query.lower())
            intent["nearAmenity"] = near_kw
            intent["farAmenity"] = far_kw

        # Normalize equipment names
        intent["requiredEquipment"] = _normalize_equipment(intent["requiredEquipment"])

        return intent

    except Exception:
        # Fallback to keyword matching
        return _fallback_parse(query)


if __name__ == "__main__":
    test_queries = [
        "我想要安静区、适合独立学习、有充电口的座位",
        "Need a quiet spot for two near a power outlet",
        "有没有小组讨论的地方，要投影仪",
        "找个安静的地方一个人学习",
        "a seat close to the stairs",
        "找个远离洗手间的安静座位",
        "quiet seat far from the toilet",
    ]
    for q in test_queries:
        print(f"\nQ: {q}")
        print(f"A: {parse(q)}")
