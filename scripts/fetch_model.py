"""Download the YOLOv8n ONNX model used for occupancy detection.

We run YOLO through ONNX Runtime rather than ultralytics, so we need the model
as a .onnx file. It's ~12MB — too big to be worth committing, and it never
changes, so we fetch it on demand instead.

Usage:
    python scripts/fetch_model.py
"""

import sys
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEST = PROJECT_ROOT / "models" / "yolov8n.onnx"

# Mirrors are tried in order. The first is the primary; the rest are fallbacks
# for networks where huggingface.co is slow or unreachable.
MIRRORS = [
    "https://huggingface.co/cabelo/yolov8/resolve/main/yolov8n.onnx",
    "https://hf-mirror.com/cabelo/yolov8/resolve/main/yolov8n.onnx",
]

MIN_BYTES = 5_000_000  # a truncated/error-page download would be far smaller


def main() -> None:
    if DEST.exists() and DEST.stat().st_size > MIN_BYTES:
        print(f"Model already present: {DEST} ({DEST.stat().st_size / 1e6:.1f} MB)")
        return

    DEST.parent.mkdir(parents=True, exist_ok=True)

    for url in MIRRORS:
        print(f"Downloading {url} ...")
        try:
            tmp = DEST.with_suffix(".onnx.part")
            urllib.request.urlretrieve(url, tmp)
            if tmp.stat().st_size < MIN_BYTES:
                tmp.unlink(missing_ok=True)
                print("  got a suspiciously small file, trying next mirror")
                continue
            tmp.replace(DEST)
            print(f"Saved {DEST} ({DEST.stat().st_size / 1e6:.1f} MB)")
            return
        except Exception as e:
            print(f"  failed: {e}")

    print(
        "\nCouldn't download the model from any mirror.\n"
        "Fetch yolov8n.onnx manually and place it at:\n"
        f"  {DEST}",
        file=sys.stderr,
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
