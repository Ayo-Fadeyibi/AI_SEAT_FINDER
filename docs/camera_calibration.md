# Camera Calibration & YOLO Occupancy Detection — Design

Status: initial implementation. This document is the reference for how camera
calibration links the floor plan to what a camera physically sees, and how
YOLO turns a camera frame into per-seat occupancy.

## 1. Goal & the core idea

Occupancy today is a manual available/occupied flag an admin toggles per seat
(`PUT /api/admin/seats/{seat_id}/status`). This feature makes that automatic:
point a camera at a room, and each seat's status is set by detecting people in
the frame.

The problem: a camera sees a **photo** (its own pixel grid, from its own
vantage point), but the floor plan is a **schematic** (an abstract top-down
diagram in a different coordinate space). Nothing automatically knows that "the
chair at pixel (840, 520) in camera CAM-1F-01's image" is the same seat as
"`1F-Q03-S1` in the floor plan." **Calibration is the one-time step that draws
that link, by hand, per seat.**

Once calibrated, every subsequent frame from that camera is interpreted the
same way — no re-linking needed until the furniture physically moves.

## 2. What links the two: the seat ID

The floor-plan builder (`LayoutEditor.tsx`) already assigns every individual
seat a stable ID: `{tableId}-S{n}` (e.g. `1F-Q03-S1`), stored as a
`type=="seat"` object in `data/layout.json`, each carrying its own
`occupancyStatus`. **That ID is the join key.** Calibration attaches a
camera-image bounding box to a seat ID; detection reports occupancy per seat
ID; the existing `PUT /api/admin/seats/{seat_id}/status` path already flips a
seat by that same ID and re-derives `seats.json`. No new ID scheme is
introduced.

Important: calibrate against **individual seats in `layout.json`**, not the
rows in `seats.json`. `seats.json` is a *derived, table-level aggregate* (one
row per table, regenerated on every layout save by
`_derive_seats_from_layout()`); its `bbox` is the table's box in *floor-plan
canvas* space, unrelated to camera pixels.

## 3. Two coordinate spaces — keep them separate

| Space | Where it lives | Units |
|---|---|---|
| Floor-plan canvas | `layout.json` seat `x/y/width/height` | pixels in the 760×510 editor viewBox |
| Camera image | `camera_calibration.json` seat boxes | **normalized 0–1 fractions** of the camera image |

These are never mixed. A seat has a position in the schematic *and* a
(calibrated) box in each camera that can see it; they describe the same chair
in two unrelated grids.

**Why normalized (0–1) camera boxes:** a later snapshot from the same camera at
a different resolution still lines up, and the frontend (which draws on a
responsively-sized `<img>`) and the detector (which works in the image's native
pixels) can each convert to/from their own pixel size without storing a fixed
resolution. Convert to pixels only at the moment of drawing or detecting.

## 4. Data model — `data/camera_calibration.json`

A new file, independent of `layout.json` and `seats.json`:

```json
{
  "cameras": [
    {
      "id": "CAM-a1b2c3d4",
      "floor": 1,
      "label": "1F East corner",
      "image": "cameras/CAM-a1b2c3d4.jpg",
      "imageWidth": 1920,
      "imageHeight": 1080,
      "calibratedAt": "2026-07-10T14:00:00",
      "seatBoxes": [
        { "seatId": "1F-Q03-S1", "x": 0.31, "y": 0.44, "w": 0.06, "h": 0.09 }
      ]
    }
  ]
}
```

- One camera covers many seats; a seat is normally covered by one camera. A
  seat visible in two cameras is an edge case we don't special-case — the last
  detection to run wins, which is acceptable.
- `image` is stored under `data/images/cameras/`. `imageWidth/imageHeight` are
  best-effort (read via Pillow if available, else `null`); nothing depends on
  them because boxes are normalized.

## 5. Backend endpoints (all admin-gated)

- `GET  /api/admin/cameras[?floor=N]` — list cameras.
- `POST /api/admin/cameras` — multipart: `file` (snapshot) + `floor` + `label`.
  Stores the image, creates the record, returns it. (First file-upload
  endpoint in the app — needs `python-multipart`.)
- `GET  /api/admin/cameras/{id}` — one camera incl. `seatBoxes`.
- `GET  /api/admin/cameras/{id}/snapshot` — serve the stored image.
- `PUT  /api/admin/cameras/{id}/calibration` — save the `seatBoxes` array.
- `DELETE /api/admin/cameras/{id}` — remove camera + its image.
- `POST /api/admin/cameras/{id}/detect` — run occupancy for this camera **now**
  and apply it. Body is optional:
  - empty → load the stored snapshot and run real YOLOv8n inference, or
  - `{ "personBoxes": [{x,y,w,h}, ...] }` (normalized) → skip YOLO and use these
    directly. This is the **test/dev path**: it exercises the full geometry →
    seat-status → UI chain with no heavyweight model or live camera.

  Either way it computes per-seat occupancy, writes each calibrated seat's
  status into `layout.json`, re-derives `seats.json`, logs it, and returns the
  per-seat result.

## 6. Setup flow — one guided sequence, not two tabs

Floor-plan building and camera calibration are coupled into a single **Setup**
admin tab with two ordered steps, because calibration depends on the plan:

- **Step 1 — Build floor plan** (the existing layout editor: floors → tables →
  seats).
- **Step 2 — Calibrate cameras**, which stays **locked until the saved layout
  has seats** (you can't calibrate seats that don't exist). Saving in step 1
  unlocks it.

Calibrating a camera:

1. Pick/add a camera for a floor (upload a still from that camera's vantage
   point — a real feed frame or any representative photo).
2. A **side-by-side** view opens: the floor-plan SVG for that floor on the
   left, the camera photo on the right. Seats on the plan are colour-coded —
   gold = the seat being calibrated, green = already done, blue = pending —
   with a running count ("8 / 12").
3. Click a seat **on the plan** (so you can see spatially which chair it is),
   then drag a box on the photo around where that seat physically appears. The
   box saves, the plan seat turns green, and the next pending seat
   auto-selects.
4. Save & confirm.

The photo box-drawing works in normalized space (mouse position relative to the
image's bounding rect ÷ its size); the plan is the seat picker, so the abstract
`{tableId}-S{n}` id is always tied to a visible spot on the map.

## 7. Detection pipeline (where YOLO runs)

Calibration is one-time setup; detection is the runtime loop, and it lives
**outside** the request/response cycle conceptually — a frame comes in, YOLO
runs, statuses update. Steps:

1. Get a frame (live feed, or the stored snapshot for MVP).
2. **YOLO** (`yolov8n` via ONNX Runtime) → bounding boxes of class `person`,
   normalized to 0–1. ~33ms/frame on CPU.
3. **Geometry (pure function):** for each calibrated seat box, mark it
   `occupied` if a person occupies it, else `available`.
4. Apply results via the existing per-seat status path.

Why YOLO over the previous plan: the earlier `src/occupancy_detector/detector.py`
sent the whole photo + a text list of seat coordinates to a **vision LLM** and
asked it to reason per-region. YOLO instead detects *people* directly and
occupancy becomes pure geometry — cheaper, faster, offline, open-source, and no
coordinate-reasoning guesswork. **YOLO replaces the MiMo-vision occupancy
path.** (MiMo is still used for the text intent parser — that's unaffected.)

### The matching rule: foot-point-in-box

A person is "in" a seat if the **bottom-center of their bounding box** (roughly
where they're sitting) falls inside the seat box. This is more robust than
strict IoU to people leaning, standing partially, or bags on the desk. A small
IoU check is available as a secondary signal, but foot-point is the primary
rule. The threshold/rule is deliberately simple and tunable.

## 8. "But students move the seats"

The reframing that resolves most of this: **YOLO detects the person, not the
chair.** Calibration maps a seat to a *region of the room*; we're really asking
"is this region occupied." A student scooting or fidgeting the chair changes
nothing — they're still in the region. The only genuine failure is furniture
being *physically rearranged* to new positions. For that:

- **MVP:** it's an operational task — re-run the wizard when furniture is known
  to have moved. In a real library that's on the order of weeks, not minutes.
- **Tolerance:** a slightly generous seat box absorbs normal drift.
- **Deferred (not built now):** auto-flagging "this region no longer looks like
  a seating spot, recalibrate." Real complexity for a slow-moving problem —
  explicitly out of scope for v1.

## 9. MVP scope & dependencies

**MVP (no live camera required):** upload a still → calibrate seats → run
detection on that still (or via supplied `personBoxes`) → verify seat statuses
flip correctly against known ground truth. This proves the whole chain end to
end; swapping in a live feed later only changes step 1 of §7.

**Dependencies:**
- `python-multipart` — required (file upload). Small, pure Python.
- `onnxruntime` + `numpy` + `pillow` — real YOLOv8n inference, **lazily
  imported**. We deliberately do **not** use `ultralytics`: it drags in
  torch/opencv/matplotlib/pandas (1–2 GB) just to run a 12 MB model. ONNX
  Runtime gives identical detections for ~135 MB installed, at ~33 ms/frame on
  CPU. The pre/post-processing (letterbox resize, NMS) is ~60 lines of numpy in
  `src/cv/detector.py`.
- The model itself (`models/yolov8n.onnx`, ~12 MB) is fetched on demand with
  `python scripts/fetch_model.py` — it's gitignored rather than committed.

The occupancy geometry is a pure function with no heavy dependencies, so it's
unit-testable and drives the whole feature even before YOLO weights are
installed.

## 10. Deferred / not in v1

- Live camera feed ingestion (RTSP/webcam) and a scheduled detection loop.
- Auto drift-detection / recalibration prompts.
- Ranking/handling a seat visible from multiple cameras.
- Per-camera detection confidence tuning UI.
