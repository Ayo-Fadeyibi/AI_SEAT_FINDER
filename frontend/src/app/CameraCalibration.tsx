import { useState, useEffect, useCallback, useRef } from "react";
import { Camera as CameraIcon, Upload, Trash2, Crosshair, ScanEye, ArrowLeft, X, RefreshCw } from "lucide-react";
import {
  fetchCameras, createCamera, deleteCamera, saveCalibration, runDetection, replaceCameraSnapshot,
  fetchCameraSnapshotUrl, fetchLayout,
  type Camera, type SeatBox, type Layout, type LayoutObject,
} from "./api";
import { PALETTE, fitLabel } from "./constants";
import { ErrorBanner, SectionTitle } from "./ui";
import { type Lang, UI } from "./i18n";

const MIN_BOX = 0.01; // ignore accidental click-without-drag boxes

function seatLabel(id: string): string {
  return id.includes("-") ? id.slice(id.lastIndexOf("-") + 1) : id;
}

/** Live camera preview (Mac webcam, or a phone's camera if opened there)
 * via getUserMedia — captures a single frame to a File on demand, reusing
 * the same multipart upload path as a manually-chosen file. Nothing is
 * sent anywhere until the admin clicks Capture. */
function WebcamCapture({ lang, onCapture, onClose }: { lang: Lang; onCapture: (file: File) => void; onClose: () => void }) {
  const t = UI[lang];
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then(stream => {
        if (cancelled) { stream.getTracks().forEach(tr => tr.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => setReady(true);
        }
      })
      .catch(e => setError(e?.message || String(e)));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(tr => tr.stop());
    };
  }, []);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (blob) onCapture(new File([blob], `webcam-${Date.now()}.jpg`, { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" style={{ background: "rgba(17,17,16,0.6)" }} onClick={onClose}>
      <div className="w-full max-w-lg border border-border" style={{ background: "#FAFAF8" }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-[10px] font-bold tracking-widest">{t.webcamTitle}</span>
          <button onClick={onClose} style={{ color: "rgba(17,17,16,0.4)" }}><X size={13} /></button>
        </div>
        <div className="p-4">
          {error ? (
            <div className="text-[10px] px-3 py-3" style={{ background: "#B940400C", color: PALETTE.occupied }}>
              {t.webcamError}: {error}
            </div>
          ) : (
            <video ref={videoRef} autoPlay playsInline muted className="w-full bg-black" style={{ maxHeight: "50vh" }} />
          )}
          <div className="mt-2 text-[9px] leading-relaxed" style={{ color: "rgba(17,17,16,0.4)" }}>{t.webcamHint}</div>
        </div>
        <div className="flex items-center gap-2 px-4 pb-4">
          <button
            disabled={!ready}
            onClick={capture}
            className="flex-1 px-3 py-2 text-[9px] font-bold disabled:opacity-40"
            style={{ background: "#111110", color: "#F0EDE6" }}
          >
            {t.webcamCapture}
          </button>
          <button onClick={onClose} className="px-3 py-2 text-[9px] font-bold" style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.6)" }}>
            {t.webcamCancel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CamerasTab({ lang }: { lang: Lang }) {
  const t = UI[lang];
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [wizardCam, setWizardCam] = useState<Camera | null>(null);

  // Add-camera form
  const [floor, setFloor] = useState<number | "">("");
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);

  // Webcam capture: either feeds the Add-camera form's `file`, or (when set
  // to an existing camera) replaces that camera's snapshot directly.
  const [webcamTarget, setWebcamTarget] = useState<Camera | "new" | null>(null);
  const [recapturing, setRecapturing] = useState(false);

  const load = useCallback(() => {
    setError(null);
    Promise.all([fetchCameras(), fetchLayout()])
      .then(([cams, lay]) => {
        setCameras(cams);
        setLayout(lay);
        if (floor === "" && lay.floors.length > 0) setFloor(lay.floors[0].number);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async () => {
    if (!file || floor === "") return;
    setUploading(true);
    setError(null);
    try {
      await createCamera(file, Number(floor), label.trim());
      setLabel("");
      setFile(null);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleWebcamCapture = async (captured: File) => {
    const target = webcamTarget;
    setWebcamTarget(null);
    if (target === "new" || target == null) {
      setFile(captured);
      return;
    }
    setRecapturing(true);
    setError(null);
    try {
      await replaceCameraSnapshot(target.id, captured);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRecapturing(false);
    }
  };

  const handleDelete = async (cam: Camera) => {
    if (!window.confirm(`${t.deleteCamera}: ${cam.label || cam.id}?`)) return;
    try {
      await deleteCamera(cam.id);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDetect = async (cam: Camera) => {
    setDetectMsg(null);
    setError(null);
    try {
      const res = await runDetection(cam.id);
      const occupied = Object.values(res.results).filter(s => s === "occupied").length;
      setDetectMsg(t.detectionDone(occupied, Object.keys(res.results).length, res.updated));
    } catch (e: any) {
      // 503 → YOLO not installed; surface the friendlier hint.
      setError(/503|yolo|ultralytics/i.test(e.message) ? t.detectionNeedsYolo : e.message);
    }
  };

  if (wizardCam) {
    return (
      <CalibrationWizard
        lang={lang}
        camera={wizardCam}
        layout={layout}
        onDone={() => { setWizardCam(null); load(); }}
      />
    );
  }

  if (loading) return <div className="text-[11px]" style={{ color: "rgba(17,17,16,0.4)" }}>{t.loadingSeats}</div>;

  const floors = layout?.floors ?? [];
  const camsByFloor = new Map<number, Camera[]>();
  for (const c of cameras) {
    if (!camsByFloor.has(c.floor)) camsByFloor.set(c.floor, []);
    camsByFloor.get(c.floor)!.push(c);
  }

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <div className="mb-4 text-[10px] max-w-2xl leading-relaxed" style={{ color: "rgba(17,17,16,0.5)" }}>
        {t.camerasIntro}
      </div>

      {/* Add camera */}
      <SectionTitle>{t.addCamera}</SectionTitle>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <select
          value={floor}
          onChange={e => setFloor(e.target.value === "" ? "" : Number(e.target.value))}
          className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
        >
          {floors.length === 0 && <option value="">{t.noFloors}</option>}
          {floors.map(f => (
            <option key={f.number} value={f.number}>{t.cameraFloor} {f.number}{f.label ? ` · ${f.label}` : ""}</option>
          ))}
        </select>
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder={t.cameraLabelPlaceholder}
          className="px-2 py-1.5 border border-border bg-background outline-none text-[10px] w-52"
        />
        <label className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold cursor-pointer" style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.7)" }}>
          <Upload size={11} /> {file ? file.name.slice(0, 24) : t.chooseSnapshot}
          <input type="file" accept="image/*" className="hidden" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button
          onClick={() => setWebcamTarget("new")}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold"
          style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.7)" }}
        >
          <CameraIcon size={11} /> {t.useWebcam}
        </button>
        <button
          disabled={uploading || !file || floor === ""}
          onClick={handleUpload}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold disabled:opacity-30"
          style={{ background: "#111110", color: "#F0EDE6" }}
        >
          <CameraIcon size={11} /> {uploading ? "…" : t.uploadCamera}
        </button>
      </div>
      {detectMsg && <div className="mb-3 text-[10px]" style={{ color: PALETTE.available }}>{detectMsg}</div>}

      {/* Camera list */}
      <div className="mt-5 flex flex-col gap-4">
        {cameras.length === 0 && (
          <div className="text-[10px]" style={{ color: "rgba(17,17,16,0.35)" }}>{t.noCamerasYet}</div>
        )}
        {[...camsByFloor.keys()].sort((a, b) => a - b).map(f => (
          <div key={f}>
            <SectionTitle>{t.cameraFloor} {f}</SectionTitle>
            <div className="flex flex-col gap-1.5">
              {camsByFloor.get(f)!.map(cam => (
                <div key={cam.id} className="flex items-center justify-between border border-border px-4 py-2.5" style={{ background: "#FFFFFF" }}>
                  <div className="flex items-center gap-3 text-[10px]">
                    <CameraIcon size={13} style={{ color: PALETTE.amenity }} />
                    <span className="font-bold">{cam.label || cam.id}</span>
                    <span style={{ color: cam.seatBoxes.length > 0 ? PALETTE.available : "rgba(17,17,16,0.4)" }}>
                      {cam.seatBoxes.length > 0 ? t.calibratedSeats(cam.seatBoxes.length) : t.notCalibratedYet}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={recapturing}
                      onClick={() => setWebcamTarget(cam)}
                      title={t.recaptureBtn}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold disabled:opacity-30"
                      style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.7)" }}
                    >
                      <RefreshCw size={11} /> {t.recaptureBtn}
                    </button>
                    <button
                      onClick={() => setWizardCam(cam)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold"
                      style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.7)" }}
                    >
                      <Crosshair size={11} /> {cam.seatBoxes.length > 0 ? t.recalibrateBtn : t.calibrateBtn}
                    </button>
                    <button
                      disabled={cam.seatBoxes.length === 0}
                      onClick={() => handleDetect(cam)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold disabled:opacity-30"
                      style={{ background: PALETTE.available, color: "#fff" }}
                    >
                      <ScanEye size={11} /> {t.runDetectionBtn}
                    </button>
                    <button
                      onClick={() => handleDelete(cam)}
                      title={t.deleteCamera}
                      className="transition-opacity hover:opacity-60"
                      style={{ color: PALETTE.occupied }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {webcamTarget && (
        <WebcamCapture lang={lang} onCapture={handleWebcamCapture} onClose={() => setWebcamTarget(null)} />
      )}
    </div>
  );
}

// ── Calibration wizard ────────────────────────────────────────────────

function CalibrationWizard({ lang, camera, layout, onDone }: {
  lang: Lang; camera: Camera; layout: Layout | null; onDone: () => void;
}) {
  const t = UI[lang];
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Record<string, SeatBox>>(
    Object.fromEntries(camera.seatBoxes.map(b => [b.seatId, b]))
  );
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const floorSeats: LayoutObject[] = (layout?.objects ?? []).filter(
    o => o.type === "seat" && o.floor === camera.floor
  );

  // Load the snapshot with auth, as an object URL; revoke on unmount.
  useEffect(() => {
    let url: string | null = null;
    fetchCameraSnapshotUrl(camera.id)
      .then(u => { url = u; setImgUrl(u); })
      .catch(e => setImgError(e.message));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [camera.id]);

  // First pending seat is selected by default.
  useEffect(() => {
    if (selectedSeat == null) {
      const firstPending = floorSeats.find(s => !boxes[s.id]);
      setSelectedSeat(firstPending?.id ?? floorSeats[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  const pointFromEvent = (clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return { x, y };
  };

  const onImageMouseDown = (e: React.MouseEvent) => {
    if (!selectedSeat) return;
    e.preventDefault();
    const p = pointFromEvent(e.clientX, e.clientY);
    startRef.current = p;
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    setDrawing(true);
  };

  useEffect(() => {
    if (!drawing) return;
    const onMove = (e: MouseEvent) => {
      const s = startRef.current;
      if (!s) return;
      const p = pointFromEvent(e.clientX, e.clientY);
      setDraft({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
    };
    const onUp = () => {
      setDrawing(false);
      const s = startRef.current;
      startRef.current = null;
      setDraft(d => {
        if (d && selectedSeat && d.w >= MIN_BOX && d.h >= MIN_BOX) {
          setBoxes(prev => {
            const next = { ...prev, [selectedSeat]: { seatId: selectedSeat, ...d } };
            // Auto-advance to the next un-calibrated seat.
            const nextPending = floorSeats.find(fs => !next[fs.id]);
            setSelectedSeat(nextPending?.id ?? selectedSeat);
            return next;
          });
        }
        return null;
      });
      void s;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, selectedSeat]);

  const clearBox = (seatId: string) => {
    setBoxes(prev => {
      const next = { ...prev };
      delete next[seatId];
      return next;
    });
  };

  const resetAllBoxes = () => {
    if (!window.confirm(t.resetAllConfirm)) return;
    setBoxes({});
    setSelectedSeat(floorSeats[0]?.id ?? null);
    setSavedMsg(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      await saveCalibration(camera.id, Object.values(boxes));
      setSavedMsg(t.calibrationSaved);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const doneCount = floorSeats.filter(s => boxes[s.id]).length;
  const cw = layout?.canvasWidth ?? 760;
  const ch = layout?.canvasHeight ?? 510;
  const floorTables = (layout?.objects ?? []).filter(o => o.type === "table" && o.floor === camera.floor);
  const activeHasBox = selectedSeat ? !!boxes[selectedSeat] : false;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onDone}
          className="flex items-center gap-1.5 text-[10px] transition-opacity hover:opacity-60"
          style={{ color: "rgba(17,17,16,0.55)" }}
        >
          <ArrowLeft size={12} /> {t.backToCameras}
        </button>
        <span className="text-[10px] font-bold" style={{ color: doneCount === floorSeats.length && floorSeats.length > 0 ? PALETTE.available : "rgba(17,17,16,0.55)" }}>
          {t.calibProgress(doneCount, floorSeats.length)}
        </span>
      </div>

      <div className="text-[11px] font-bold mb-1">{t.calibrateTitle} · {camera.label || camera.id}</div>
      <div className="mb-3 text-[10px] max-w-2xl leading-relaxed" style={{ color: "rgba(17,17,16,0.5)" }}>
        {t.calibrateHint}
      </div>
      {error && <ErrorBanner message={error} />}

      {floorSeats.length === 0 ? (
        <div className="text-[10px] px-3 py-3" style={{ background: "rgba(200,168,75,0.1)", color: "#8a6f2e" }}>{t.noSeatsToCalib}</div>
      ) : (
        <>
          <div className="flex gap-4 items-start">
            {/* Left: floor plan — click a seat to select it */}
            <div className="flex-1 min-w-0">
              <div className="text-[9px] mb-1.5 flex items-center gap-3" style={{ color: "rgba(17,17,16,0.5)" }}>
                <span>{t.planColumn}</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2" style={{ background: PALETTE.gold }} /> {t.legendActive}</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2" style={{ background: PALETTE.available }} /> {t.legendDone}</span>
              </div>
              <svg viewBox={`0 0 ${cw} ${ch}`} className="w-full border border-border" style={{ background: "#FAFAF8", maxHeight: "62vh" }}>
                {floorTables.map(tbl => (
                  <rect key={tbl.id} x={tbl.x} y={tbl.y} width={tbl.width} height={tbl.height} rx={5}
                    fill="none" stroke="rgba(17,17,16,0.15)" strokeWidth={1} strokeDasharray="4 3" />
                ))}
                {floorSeats.map(seat => {
                  const has = !!boxes[seat.id];
                  const active = seat.id === selectedSeat;
                  const color = active ? PALETTE.gold : has ? PALETTE.available : "#8aa0b8";
                  const { text, fontSize } = fitLabel(seatLabel(seat.id), seat.width, 7, 5.5);
                  return (
                    <g key={seat.id} onClick={() => setSelectedSeat(seat.id)} style={{ cursor: "pointer" }}>
                      <rect x={seat.x} y={seat.y} width={seat.width} height={seat.height} rx={3}
                        fill={color} fillOpacity={active ? 0.85 : has ? 0.4 : 0.22}
                        stroke={color} strokeWidth={active ? 2.5 : 1} />
                      <text x={seat.x + seat.width / 2} y={seat.y + seat.height / 2} fontSize={fontSize}
                        fontFamily="'JetBrains Mono', monospace" fontWeight="700"
                        fill={active ? "#111" : color} textAnchor="middle" dominantBaseline="central">
                        {text}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Right: camera photo — drag a box for the selected seat */}
            <div className="flex-1 min-w-0">
              <div className="text-[9px] mb-1.5" style={{ color: "rgba(17,17,16,0.5)" }}>
                {selectedSeat ? t.drawingFor(seatLabel(selectedSeat)) : t.selectSeatToDraw}
              </div>
              <div
                ref={wrapRef}
                onMouseDown={onImageMouseDown}
                className="relative border border-border select-none"
                style={{ background: "#000", cursor: selectedSeat ? "crosshair" : "default", lineHeight: 0 }}
              >
                {imgError && <div className="p-6 text-[10px]" style={{ color: PALETTE.occupied }}>{imgError}</div>}
                {imgUrl && (
                  <img src={imgUrl} alt="camera snapshot" draggable={false} className="w-full h-auto block" style={{ maxHeight: "62vh", objectFit: "contain", pointerEvents: "none" }} />
                )}

                {/* Saved seat boxes */}
                {Object.values(boxes).map(b => {
                  const isSel = b.seatId === selectedSeat;
                  return (
                    <div
                      key={b.seatId}
                      className="absolute flex items-start justify-start"
                      style={{
                        left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`,
                        border: `2px solid ${isSel ? PALETTE.gold : PALETTE.available}`,
                        background: `${isSel ? PALETTE.gold : PALETTE.available}22`,
                        pointerEvents: "none",
                      }}
                    >
                      <span className="text-[8px] font-bold px-1" style={{ background: isSel ? PALETTE.gold : PALETTE.available, color: "#111", lineHeight: 1.4 }}>
                        {seatLabel(b.seatId)}
                      </span>
                    </div>
                  );
                })}

                {/* In-progress draft box */}
                {draft && (
                  <div
                    className="absolute"
                    style={{
                      left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%`,
                      border: `2px dashed ${PALETTE.gold}`, background: `${PALETTE.gold}22`, pointerEvents: "none",
                    }}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3 mt-3">
            <button
              disabled={saving}
              onClick={handleSave}
              className="px-3 py-2 text-[9px] font-bold disabled:opacity-40"
              style={{ background: PALETTE.available, color: "#fff" }}
            >
              {saving ? "…" : t.saveCalibrationBtn}
            </button>
            {activeHasBox && selectedSeat && (
              <button
                onClick={() => clearBox(selectedSeat)}
                className="flex items-center gap-1 px-2.5 py-2 text-[9px] font-bold"
                style={{ background: `${PALETTE.occupied}18`, color: PALETTE.occupied }}
              >
                <Trash2 size={11} /> {t.clearBox} ({seatLabel(selectedSeat)})
              </button>
            )}
            {Object.keys(boxes).length > 0 && (
              <button
                onClick={resetAllBoxes}
                className="flex items-center gap-1 px-2.5 py-2 text-[9px] font-bold transition-opacity hover:opacity-70"
                style={{ color: "rgba(17,17,16,0.45)" }}
              >
                <RefreshCw size={11} /> {t.resetAllBtn}
              </button>
            )}
            {savedMsg && <span className="text-[10px]" style={{ color: PALETTE.available }}>{savedMsg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
