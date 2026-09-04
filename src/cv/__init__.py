"""Computer-vision occupancy: YOLO person detection + seat-occupancy geometry.

This package replaces the older vision-LLM occupancy prototype in
`src/occupancy_detector/`. See docs/camera_calibration.md for the full design.

The geometry (`compute_seat_occupancy`) is pure and dependency-free. The YOLO
wrapper (`detect_person_boxes`) runs YOLOv8n through ONNX Runtime (no torch)
and imports it lazily, so importing this package never requires the inference
stack to be present.
"""

from src.cv.detector import compute_seat_occupancy, detect_person_boxes

__all__ = ["compute_seat_occupancy", "detect_person_boxes"]
