"""
Bilingual (zh/en) string templating for CLI output.

Supports dynamic language switching. All UI strings go through t(key).
"""

LANG_PACK = {
    "zh": {
        # ── General ──
        "app_title": "===== FindaSpot: 智能座位推荐系统 =====",
        "commands_tip": "命令: 输入 zh 切换中文 / en 切换英文 / exit 退出",
        "input_tip": "请描述你想要的座位：",
        "lang_switched": "已切换到中文",

        # ── Intent parsing ──
        "parsing": "正在解析你的需求...",
        "parsed_intent": "解析结果：",
        "intent_zone": "  区域偏好: {zone}",
        "intent_group": "  人数: {size}",
        "intent_equip": "  设备需求: {equip}",
        "intent_access": "  无障碍需求: {access}",
        "parse_failed": "LLM 解析失败，使用关键词匹配回退",

        # ── Optimizer ──
        "recommend_title": "推荐结果：",
        "perfect_match": "找到完美匹配！",
        "no_seat": "暂无满足全部条件的空闲座位，为你推荐次优选项：",
        "empty_msg": "当前无匹配座位，所有座位均已被占用",
        "fallback_reason": "  原因: {reason}",

        # ── Seat info ──
        "seat_info": (
            "\n  座位: {name} ({id})\n"
            "  区域: {zone}\n"
            "  楼层: {floor}F\n"
            "  容量: {cap}人\n"
            "  设备: {equipment}\n"
            "  位置: {location}\n"
            "  状态: {status}"
        ),
        "available": "空闲",
        "occupied": "占用",
        "quiet_zone": "安静区",
        "collaborative_zone": "协作区",
        "power_outlet": "充电口",
        "projector": "投影仪",
        "no_equipment": "无",

        # ── Visual marker ──
        "visual_hint": "  [视觉标记] 坐标: {bbox}",

        # ── Demo ──
        "demo_queries": "试试这些查询:",
        "demo_q1": "  - 我想要安静区、适合独立学习、有充电口的座位",
        "demo_q2": "  - 找个能4个人一起讨论的地方",
        "demo_q3": "  - 有没有安静的双人座，需要充电",
    },
    "en": {
        # ── General ──
        "app_title": "===== FindaSpot: Smart Seat Recommender =====",
        "commands_tip": "Commands: type zh for Chinese / en for English / exit to quit",
        "input_tip": "Describe your ideal seat:",
        "lang_switched": "Switched to English",

        # ── Intent parsing ──
        "parsing": "Parsing your request...",
        "parsed_intent": "Parsed Intent:",
        "intent_zone": "  Zone preference: {zone}",
        "intent_group": "  Group size: {size}",
        "intent_equip": "  Equipment needs: {equip}",
        "intent_access": "  Accessibility: {access}",
        "parse_failed": "LLM parse failed, using keyword fallback",

        # ── Optimizer ──
        "recommend_title": "Recommendation:",
        "perfect_match": "Perfect match found!",
        "no_seat": "No seats fully match your criteria. Here's the best alternative:",
        "empty_msg": "No matching seats available — all seats are occupied",
        "fallback_reason": "  Reason: {reason}",

        # ── Seat info ──
        "seat_info": (
            "\n  Seat: {name} ({id})\n"
            "  Zone: {zone}\n"
            "  Floor: {floor}F\n"
            "  Capacity: {cap} person(s)\n"
            "  Equipment: {equipment}\n"
            "  Location: {location}\n"
            "  Status: {status}"
        ),
        "available": "Available",
        "occupied": "Occupied",
        "quiet_zone": "Quiet Zone",
        "collaborative_zone": "Collaborative Zone",
        "power_outlet": "Power Outlet",
        "projector": "Projector",
        "no_equipment": "None",

        # ── Visual marker ──
        "visual_hint": "  [Visual Marker] Coords: {bbox}",

        # ── Demo ──
        "demo_queries": "Try these queries:",
        "demo_q1": "  - I want a quiet seat for individual study with a power outlet",
        "demo_q2": "  - Need a group study spot for 4 people",
        "demo_q3": "  - Any quiet seat for two? Need charging.",
    },
}

CUR_LANG = "en"


def t(key: str, **kwargs) -> str:
    """Translate a key into the current language, with optional formatting."""
    template = LANG_PACK[CUR_LANG].get(key, key)
    if kwargs:
        return template.format(**kwargs)
    return template


def switch_lang(lang_code: str):
    """Switch the current language (zh / en)."""
    global CUR_LANG
    if lang_code in LANG_PACK:
        CUR_LANG = lang_code


def get_lang() -> str:
    """Return the current language code."""
    return CUR_LANG
