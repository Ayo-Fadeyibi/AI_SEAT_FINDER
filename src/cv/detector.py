"""YOLO person detection and seat-occupancy geometry.

Two independent concerns, deliberately kept separate:

1. `compute_seat_occupancy` — a PURE function turning a set of calibrated seat
   boxes plus detected person boxes into per-seat available/occupied. No
   dependencies, fully unit-testable, drives the whole feature even with no
   model installed.

2. `detect_person_boxes` — real YOLOv8 inference via **ONNX Runtime**, not
   ultralytics. Same model (yolov8n, COCO), but the runtime is ~25MB instead
   of dragging in torch + opencv + matplotlib + pandas (1-2GB) to run a 12MB
   model. Heavy imports stay LAZY so this module imports fine with nothing
   installed. Get the model with: python scripts/fetch_model.py

All boxes are dicts of NORMALIZED coordinates in [0, 1] with a top-left origin:
`{"x", "y", "w", "h"}`. Seat boxes additionally carry `"seatId"`. Keeping
everything normalized means the camera image's pixel resolution never matters.
"""

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_PATH = PROJECT_ROOT / "models" / "yolov8n.onnx"

# COCO class index for "person" — what we treat as an occupant.
_PERSON_CLASS = 0

# yolov8n's fixed input resolution.
_INPUT_SIZE = 640

# Detection thresholds. Confidence is deliberately middling: a missed person
# marks a taken seat "free" (bad), a false positive marks a free seat "taken"
# (annoying but safe), so we lean slightly toward recall.
_CONF_THRESHOLD = 0.30
_NMS_IOU = 0.45

# Foot-point rule is primary; IoU is a secondary signal for people whose
# bounding box overlaps a seat heavily without the foot-point landing inside
# (e.g. someone leaning back). Deliberately generous — see docs.
_IOU_THRESHOLD = 0.15

_session = None


# ── Pure geometry (no dependencies) ───────────────────────────────────

def _point_in_box(px: float, py: float, box: dict) -> bool:
    return box["x"] <= px <= box["x"] + box["w"] and box["y"] <= py <= box["y"] + box["h"]


def _iou(a: dict, b: dict) -> float:
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    ix1, iy1 = max(a["x"], b["x"]), max(a["y"], b["y"])
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def compute_seat_occupancy(
    seat_boxes: list[dict],
    person_boxes: list[dict],
    iou_threshold: float = _IOU_THRESHOLD,
) -> dict[str, str]:
    """Map each calibrated seat to "occupied" or "available".

    A seat is occupied if any detected person's foot-point (bottom-centre of
    their box, ~where they sit) falls inside the seat box, or their box has
    significant IoU with it. YOLO detects the person, not the chair, so a seat
    box really represents a *region of the room* — small movements of the
    physical chair don't matter as long as the occupant stays in the region.
    """
    result: dict[str, str] = {}
    for seat in seat_boxes:
        occupied = False
        for p in person_boxes:
            foot_x = p["x"] + p["w"] / 2
            foot_y = p["y"] + p["h"]
            if _point_in_box(foot_x, foot_y, seat) or _iou(seat, p) >= iou_threshold:
                occupied = True
                break
        result[seat["seatId"]] = "occupied" if occupied else "available"
    return result


# ── YOLOv8 via ONNX Runtime ───────────────────────────────────────────

def model_path() -> Path:
    return Path(os.environ.get("FINDASPOT_YOLO_MODEL", str(DEFAULT_MODEL_PATH)))


def _get_session():
    """Load and cache the ONNX session. Lazily imports onnxruntime."""
    global _session
    if _session is None:
        import onnxruntime as ort  # lazy: keeps this module importable bare

        path = model_path()
        if not path.exists():
            raise FileNotFoundError(
                f"YOLO model not found at {path}. Run: python scripts/fetch_model.py"
            )
        _session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return _session


def _letterbox(img, size: int = _INPUT_SIZE):
    """Resize preserving aspect ratio, pad to a square `size` canvas.

    Returns (canvas, scale, dx, dy) so detections can be mapped back to the
    original image's pixel space.
    """
    from PIL import Image

    orig_w, orig_h = img.size
    scale = min(size / orig_w, size / orig_h)
    new_w, new_h = round(orig_w * scale), round(orig_h * scale)
    resized = img.resize((new_w, new_h), Image.BILINEAR)

    canvas = Image.new("RGB", (size, size), (114, 114, 114))  # YOLO's pad grey
    dx, dy = (size - new_w) // 2, (size - new_h) // 2
    canvas.paste(resized, (dx, dy))
    return canvas, scale, dx, dy


def _nms(boxes, scores, iou_threshold: float):
    """Plain numpy non-max suppression. boxes are [x1, y1, x2, y2]."""
    import numpy as np

    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]

    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= iou_threshold]
    return keep


def detect_person_boxes(image_path: str, conf_threshold: float = _CONF_THRESHOLD) -> list[dict]:
    """Run YOLOv8n on an image and return normalized person boxes.

    Needs `onnxruntime`, `numpy`, `pillow` and the model file (see
    scripts/fetch_model.py). Notably does NOT need torch/ultralytics.
    """
    import numpy as np
    from PIL import Image

    session = _get_session()

    img = Image.open(image_path).convert("RGB")
    orig_w, orig_h = img.size
    canvas, scale, dx, dy = _letterbox(img)

    # HWC uint8 -> CHW float32 batch, scaled to [0, 1]
    tensor = np.asarray(canvas, dtype=np.float32) / 255.0
    tensor = tensor.transpose(2, 0, 1)[np.newaxis, ...]

    outputs = session.run(None, {session.get_inputs()[0].name: tensor})

    # yolov8 detection head: (1, 84, 8400) — 4 bbox (cx,cy,w,h) + 80 class scores
    preds = outputs[0][0].T  # -> (8400, 84)
    person_scores = preds[:, 4 + _PERSON_CLASS]
    hits = person_scores >= conf_threshold
    if not hits.any():
        return []

    cxcywh = preds[hits, :4]
    scores = person_scores[hits]

    # cx,cy,w,h -> x1,y1,x2,y2 (still in letterboxed 640-space)
    xyxy = np.empty_like(cxcywh)
    xyxy[:, 0] = cxcywh[:, 0] - cxcywh[:, 2] / 2
    xyxy[:, 1] = cxcywh[:, 1] - cxcywh[:, 3] / 2
    xyxy[:, 2] = cxcywh[:, 0] + cxcywh[:, 2] / 2
    xyxy[:, 3] = cxcywh[:, 1] + cxcywh[:, 3] / 2

    keep = _nms(xyxy, scores, _NMS_IOU)

    boxes: list[dict] = []
    for i in keep:
        x1, y1, x2, y2 = xyxy[i]
        # undo letterbox padding + scaling, back to original pixel space
        x1 = (x1 - dx) / scale
        y1 = (y1 - dy) / scale
        x2 = (x2 - dx) / scale
        y2 = (y2 - dy) / scale
        # clamp to the image, then normalize to 0-1
        x1 = max(0.0, min(float(x1), orig_w))
        y1 = max(0.0, min(float(y1), orig_h))
        x2 = max(0.0, min(float(x2), orig_w))
        y2 = max(0.0, min(float(y2), orig_h))
        if x2 <= x1 or y2 <= y1:
            continue
        boxes.append({
            "x": x1 / orig_w,
            "y": y1 / orig_h,
            "w": (x2 - x1) / orig_w,
            "h": (y2 - y1) / orig_h,
            "conf": float(scores[i]),
        })
    return boxes
