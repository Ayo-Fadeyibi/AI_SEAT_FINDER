import { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, Trash2, Undo2, Redo2, Armchair, Table2, Sparkles, MapPin,
} from "lucide-react";
import {
  fetchLayout, saveLayout,
  type Layout, type LayoutObject, type FloorMeta, type ZoneType, type Equipment, type AmenityType,
} from "./api";
import { PALETTE, fitLabel, DEFAULT_SEAT_SIZE, DEFAULT_AMENITY_SIZE, AMENITY_ABBR, AMENITY_TYPES } from "./constants";
import { AMENITY_LABEL } from "./i18n";
import { ErrorBanner, SectionTitle } from "./ui";

const OBJECT_COLOR = {
  table: PALETTE.available,
  seat: "#4A90A4",
  amenity: PALETTE.amenity,
} as const;

const DEFAULT_TABLE_SIZE = { width: 90, height: 65 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max <= min ? min : max);
}

function nextFloorNumber(floors: FloorMeta[]): number {
  return floors.length > 0 ? Math.max(...floors.map(f => f.number)) + 1 : 1;
}

function nextTableId(): string {
  return `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
}

function nextAmenityId(): string {
  return `A${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
}

function nextSeatId(tableId: string, existingSeats: LayoutObject[]): string {
  const pattern = new RegExp(`^${tableId}-S(\\d+)$`);
  const nums = existingSeats
    .map(s => s.id.match(pattern))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => parseInt(m[1], 10));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${tableId}-S${next}`;
}

interface Snapshot {
  floors: FloorMeta[];
  objects: LayoutObject[];
}

interface Selection {
  type: "table" | "seat" | "amenity";
  id: string;
}

interface DragState {
  id: string;
  offsetX: number;
  offsetY: number;
}

export default function LayoutEditor({ onSaved }: { onSaved?: () => void } = {}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [floors, setFloors] = useState<FloorMeta[]>([]);
  const [objects, setObjects] = useState<LayoutObject[]>([]);
  const [canvasWidth, setCanvasWidth] = useState(760);
  const [canvasHeight, setCanvasHeight] = useState(510);

  const [history, setHistory] = useState<Snapshot[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [activeFloor, setActiveFloor] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [creatingTable, setCreatingTable] = useState(false);
  const [draft, setDraft] = useState({
    name: "", width: DEFAULT_TABLE_SIZE.width, height: DEFAULT_TABLE_SIZE.height,
    seatCount: 1, zoneType: "quiet" as ZoneType, equipment: [] as Equipment[],
  });

  const [creatingAmenity, setCreatingAmenity] = useState(false);
  const [amenityDraft, setAmenityDraft] = useState({ name: "", amenityType: "toilet" as AmenityType });

  useEffect(() => {
    fetchLayout()
      .then((data: Layout) => {
        setFloors(data.floors);
        setObjects(data.objects);
        setCanvasWidth(data.canvasWidth);
        setCanvasHeight(data.canvasHeight);
        setHistory([{ floors: data.floors, objects: data.objects }]);
        setHistoryIndex(0);
        if (data.floors.length > 0) setActiveFloor(data.floors[0].number);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // ── History: one snapshot per committed action, not per drag frame ──
  const commit = useCallback((newFloors: FloorMeta[], newObjects: LayoutObject[]) => {
    setFloors(newFloors);
    setObjects(newObjects);
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIndex + 1);
      return [...trimmed, { floors: newFloors, objects: newObjects }];
    });
    setHistoryIndex(i => i + 1);
  }, [historyIndex]);

  const undo = () => {
    if (historyIndex <= 0) return;
    const i = historyIndex - 1;
    setHistoryIndex(i);
    setFloors(history[i].floors);
    setObjects(history[i].objects);
  };

  const redo = () => {
    if (historyIndex >= history.length - 1) return;
    const i = historyIndex + 1;
    setHistoryIndex(i);
    setFloors(history[i].floors);
    setObjects(history[i].objects);
  };

  // ── Floors ────────────────────────────────────────────────────────
  const handleAddFloor = () => {
    const number = nextFloorNumber(floors);
    const newFloors = [...floors, { number, label: "" }];
    commit(newFloors, objects);
    setActiveFloor(number);
  };

  const handleDeleteFloor = (number: number) => {
    if (!window.confirm(`Delete floor ${number}? This removes every table and seat on it.`)) return;
    const newFloors = floors.filter(f => f.number !== number);
    const newObjects = objects.filter(o => o.floor !== number);
    commit(newFloors, newObjects);
    setSelection(null);
    setActiveFloor(newFloors.length > 0 ? newFloors[0].number : null);
  };

  const handleRenameFloor = (number: number, label: string) => {
    setFloors(prev => prev.map(f => f.number === number ? { ...f, label } : f));
  };

  const commitFloorRename = () => {
    commit(floors, objects);
  };

  // ── Tables & seats ────────────────────────────────────────────────
  const buildTable = (
    id: string, floor: number, x: number, y: number,
    opts: { name?: string; width?: number; height?: number; zoneType?: ZoneType; equipment?: Equipment[] } = {}
  ): LayoutObject => ({
    id, type: "table",
    x, y, width: opts.width ?? DEFAULT_TABLE_SIZE.width, height: opts.height ?? DEFAULT_TABLE_SIZE.height,
    name: opts.name ?? "New Table", location: "", rotation: 0,
    zoneType: opts.zoneType ?? "quiet", capacity: 0, equipment: opts.equipment ?? [], floor, color: "",
  });

  const buildSeat = (id: string, tableId: string, floor: number, x: number, y: number): LayoutObject => ({
    id, type: "seat",
    x, y, width: DEFAULT_SEAT_SIZE, height: DEFAULT_SEAT_SIZE,
    name: "", location: "", rotation: 0, zoneType: "", capacity: 1, equipment: [],
    floor, color: "", tableId, occupancyStatus: "available",
  });

  const buildAmenity = (id: string, floor: number, x: number, y: number, amenityType: AmenityType, name: string): LayoutObject => ({
    id, type: "amenity",
    x, y, width: DEFAULT_AMENITY_SIZE, height: DEFAULT_AMENITY_SIZE,
    name, location: "", rotation: 0, zoneType: "", capacity: 0, equipment: [],
    floor, color: "", amenityType,
  });

  /** Grid positions for `count` seats under a table of the given box, wrapping
   * into rows so a table with many seats (e.g. a lounge or seminar room)
   * doesn't spill a single row off the canvas. */
  const arrangeSeatPositions = (x: number, y: number, width: number, height: number, count: number) => {
    const cols = Math.max(1, Math.min(count, Math.floor(width / (DEFAULT_SEAT_SIZE + 4)) || 1, 6));
    const positions: { x: number; y: number }[] = [];
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      positions.push({
        x: clamp(x + col * (DEFAULT_SEAT_SIZE + 4), 0, canvasWidth - DEFAULT_SEAT_SIZE),
        y: clamp(y + height + 6 + row * (DEFAULT_SEAT_SIZE + 4), 0, canvasHeight - DEFAULT_SEAT_SIZE),
      });
    }
    return positions;
  };

  // Repeated "Add Table" clicks would otherwise stack every table at the
  // same (40,40) — cascade the default position a bit per existing table
  // on this floor, wrapping so it never runs off-canvas.
  const nextTablePosition = (width: number, height: number) => {
    const existingOnFloor = objects.filter(o => o.type === "table" && o.floor === activeFloor).length;
    const offset = (existingOnFloor % 8) * 24;
    return {
      x: clamp(40 + offset, 0, canvasWidth - width),
      y: clamp(40 + offset, 0, canvasHeight - height),
    };
  };

  // Amenities cascade down the right edge of the canvas so they don't
  // collide with tables placed via nextTablePosition's top-left cascade.
  const nextAmenityPosition = () => {
    const existingOnFloor = objects.filter(o => o.type === "amenity" && o.floor === activeFloor).length;
    const offset = (existingOnFloor % 10) * (DEFAULT_AMENITY_SIZE + 8);
    return {
      x: clamp(canvasWidth - DEFAULT_AMENITY_SIZE - 16, 0, canvasWidth - DEFAULT_AMENITY_SIZE),
      y: clamp(16 + offset, 0, canvasHeight - DEFAULT_AMENITY_SIZE),
    };
  };

  const openCreateForm = () => {
    if (activeFloor == null) return;
    setDraft({ name: "", width: DEFAULT_TABLE_SIZE.width, height: DEFAULT_TABLE_SIZE.height, seatCount: 1, zoneType: "quiet", equipment: [] });
    setSelection(null);
    setCreatingAmenity(false);
    setCreatingTable(true);
  };

  const closeCreateForm = () => setCreatingTable(false);

  const openCreateAmenityForm = () => {
    if (activeFloor == null) return;
    setAmenityDraft({ name: "", amenityType: "toilet" });
    setSelection(null);
    setCreatingTable(false);
    setCreatingAmenity(true);
  };

  const closeCreateAmenityForm = () => setCreatingAmenity(false);

  const handleCreateAmenity = () => {
    if (activeFloor == null) return;
    const { x, y } = nextAmenityPosition();
    const id = nextAmenityId();
    const amenity = buildAmenity(id, activeFloor, x, y, amenityDraft.amenityType, amenityDraft.name.trim() || AMENITY_LABEL.en[amenityDraft.amenityType]);
    commit(floors, [...objects, amenity]);
    setSelection({ type: "amenity", id });
    setCreatingAmenity(false);
  };

  const handleCreateTable = () => {
    if (activeFloor == null) return;
    const width = clamp(Math.round(draft.width) || DEFAULT_TABLE_SIZE.width, 24, canvasWidth);
    const height = clamp(Math.round(draft.height) || DEFAULT_TABLE_SIZE.height, 24, canvasHeight);
    const seatCount = Math.max(0, Math.min(24, Math.round(draft.seatCount) || 0));
    const { x, y } = nextTablePosition(width, height);

    const tableId = nextTableId();
    const table = buildTable(tableId, activeFloor, x, y, {
      name: draft.name.trim() || "New Table", width, height, zoneType: draft.zoneType, equipment: draft.equipment,
    });
    const seats = arrangeSeatPositions(x, y, width, height, seatCount)
      .map((pos, i) => buildSeat(`${tableId}-S${i + 1}`, tableId, activeFloor, pos.x, pos.y));

    commit(floors, [...objects, table, ...seats]);
    setSelection({ type: "table", id: tableId });
    setCreatingTable(false);
  };

  const toggleDraftEquipment = (item: Equipment) => {
    setDraft(prev => ({
      ...prev,
      equipment: prev.equipment.includes(item) ? prev.equipment.filter(e => e !== item) : [...prev.equipment, item],
    }));
  };

  const handleAddSeat = (tableId: string) => {
    const table = objects.find(o => o.id === tableId);
    if (!table) return;
    const existingSeats = objects.filter(o => o.type === "seat" && o.tableId === tableId);
    const id = nextSeatId(tableId, existingSeats);
    const x = clamp(table.x + existingSeats.length * (DEFAULT_SEAT_SIZE + 4), 0, canvasWidth - DEFAULT_SEAT_SIZE);
    const y = clamp(table.y + table.height + 6, 0, canvasHeight - DEFAULT_SEAT_SIZE);
    commit(floors, [...objects, buildSeat(id, tableId, table.floor, x, y)]);
  };

  // A layout can be nothing but standalone seats (solo desks, no real
  // "table" concept in the admin's head) — this button works with no
  // selection at all. If a table is selected, add to it as usual; if
  // not, spin up a minimal one-seat table so the flow never blocks on
  // "you must select a table first."
  const handleAddSeatButton = () => {
    if (selectedTable) {
      handleAddSeat(selectedTable.id);
      return;
    }
    if (activeFloor == null) return;
    const tableId = nextTableId();
    const { x, y } = nextTablePosition(DEFAULT_TABLE_SIZE.width, DEFAULT_TABLE_SIZE.height);
    const table = buildTable(tableId, activeFloor, x, y, { name: "New Seat" });
    const seatId = nextSeatId(tableId, []);
    const seat = buildSeat(seatId, tableId, activeFloor, table.x + 4, table.y + table.height + 6);
    commit(floors, [...objects, table, seat]);
    setSelection({ type: "table", id: tableId });
  };

  const handleDelete = () => {
    if (!selection) return;
    let newObjects: LayoutObject[];
    if (selection.type === "table") {
      newObjects = objects.filter(o => o.id !== selection.id && o.tableId !== selection.id);
    } else {
      newObjects = objects.filter(o => o.id !== selection.id);
    }
    commit(floors, newObjects);
    setSelection(null);
  };

  const updateSelectedTable = (patch: Partial<LayoutObject>) => {
    if (!selection || selection.type !== "table") return;
    setObjects(prev => prev.map(o => o.id === selection.id ? { ...o, ...patch } : o));
  };

  const updateSelectedAmenity = (patch: Partial<LayoutObject>) => {
    if (!selection || selection.type !== "amenity") return;
    setObjects(prev => prev.map(o => o.id === selection.id ? { ...o, ...patch } : o));
  };

  const commitEdit = () => {
    commit(floors, objects);
  };

  const toggleEquipment = (item: Equipment) => {
    if (!selection || selection.type !== "table") return;
    const table = objects.find(o => o.id === selection.id);
    if (!table) return;
    const has = table.equipment.includes(item);
    const equipment = has ? table.equipment.filter(e => e !== item) : [...table.equipment, item];
    const newObjects = objects.map(o => o.id === table.id ? { ...o, equipment } : o);
    commit(floors, newObjects);
  };

  // ── Drag ──────────────────────────────────────────────────────────
  const toSvgPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const svgPt = pt.matrixTransform(ctm.inverse());
    return { x: svgPt.x, y: svgPt.y };
  };

  const handleMouseDown = (obj: LayoutObject, e: React.MouseEvent) => {
    e.stopPropagation();
    const pt = toSvgPoint(e.clientX, e.clientY);
    setDragging({ id: obj.id, offsetX: pt.x - obj.x, offsetY: pt.y - obj.y });
    setSelection({ type: obj.type as "table" | "seat" | "amenity", id: obj.id });
    setCreatingTable(false);
    setCreatingAmenity(false);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const pt = toSvgPoint(e.clientX, e.clientY);
      setObjects(prev => {
        const draggedObj = prev.find(o => o.id === dragging.id);
        if (!draggedObj) return prev;
        const x = clamp(pt.x - dragging.offsetX, 0, canvasWidth - draggedObj.width);
        const y = clamp(pt.y - dragging.offsetY, 0, canvasHeight - draggedObj.height);
        const dx = x - draggedObj.x;
        const dy = y - draggedObj.y;
        return prev.map(o => {
          if (o.id === dragging.id) return { ...o, x, y };
          // Dragging a table carries its own seats along with it, each still
          // independently clamped so the group never drags off-canvas.
          if (draggedObj.type === "table" && o.type === "seat" && o.tableId === draggedObj.id) {
            return {
              ...o,
              x: clamp(o.x + dx, 0, canvasWidth - o.width),
              y: clamp(o.y + dy, 0, canvasHeight - o.height),
            };
          }
          return o;
        });
      });
    };
    const onUp = () => {
      setDragging(null);
      // Commit exactly one snapshot for the whole drag gesture.
      setObjects(current => {
        commit(floors, current);
        return current;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, canvasWidth, canvasHeight]);

  // ── Save ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    setError(null);
    try {
      const result = await saveLayout(objects, floors, canvasWidth, canvasHeight);
      setSaveMessage(`Saved. ${result.seats_count} table(s) with seats are live for students.`);
      onSaved?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-[11px]" style={{ color: "rgba(17,17,16,0.4)" }}>Loading…</div>;
  }

  const floorObjects = objects.filter(o => o.floor === activeFloor);
  const floorTables = floorObjects.filter(o => o.type === "table");
  const selectedTable = selection?.type === "table" ? objects.find(o => o.id === selection.id) ?? null : null;
  const selectedTableSeats = selectedTable ? objects.filter(o => o.type === "seat" && o.tableId === selectedTable.id) : [];
  const selectedAmenity = selection?.type === "amenity" ? objects.find(o => o.id === selection.id) ?? null : null;
  const currentFloorMeta = floors.find(f => f.number === activeFloor) ?? null;

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      <div className="mb-4 text-[10px] max-w-xl leading-relaxed" style={{ color: "rgba(17,17,16,0.5)" }}>
        Build the floor plan by hand: add a floor, then "Add Seat" for a standalone desk or "Add
        Table" first if you want to group several seats together under one name. Drag a table and
        its seats travel with it. Changes are local until you hit Save — use Undo if something
        goes wrong.
      </div>

      {/* Floors */}
      <SectionTitle>FLOORS</SectionTitle>
      <div className="flex items-center gap-1 mb-4 flex-wrap">
        {floors.map(f => (
          <button
            key={f.number}
            onClick={() => { setActiveFloor(f.number); setSelection(null); }}
            className="px-3 py-1.5 text-[10px] font-bold"
            style={{
              background: activeFloor === f.number ? "#111110" : "rgba(17,17,16,0.06)",
              color: activeFloor === f.number ? "#F0EDE6" : "rgba(17,17,16,0.5)",
            }}
          >
            Floor {f.number}{f.label ? ` · ${f.label}` : ""}
          </button>
        ))}
        <button
          onClick={handleAddFloor}
          className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-bold"
          style={{ background: "rgba(61,139,94,0.12)", color: PALETTE.available }}
        >
          <Plus size={11} /> ADD FLOOR
        </button>
      </div>

      {floors.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 border border-dashed border-border">
          <Sparkles size={18} style={{ color: PALETTE.gold }} />
          <div className="text-[11px] font-bold">Let's set up your library</div>
          <div className="text-[10px] max-w-sm text-center" style={{ color: "rgba(17,17,16,0.5)" }}>
            Start by adding your first floor. From there you can add tables and seats and drag them
            into place.
          </div>
          <button
            onClick={handleAddFloor}
            className="flex items-center gap-1.5 px-3 py-2 text-[9px] font-bold"
            style={{ background: "#111110", color: "#F0EDE6" }}
          >
            <Plus size={11} /> ADD YOUR FIRST FLOOR
          </button>
        </div>
      ) : (
        <>
          {/* Floor label + delete */}
          <div className="flex items-end gap-2 mb-4">
            <div className="flex-1 max-w-sm">
              <div className="text-[8px] tracking-[0.18em] mb-1" style={{ color: "rgba(17,17,16,0.35)" }}>
                FLOOR {activeFloor} NAME
              </div>
              <input
                value={currentFloorMeta?.label ?? ""}
                onChange={e => activeFloor != null && handleRenameFloor(activeFloor, e.target.value)}
                onBlur={commitFloorRename}
                placeholder='e.g. "Ground Floor" or "General Access · 9am-10pm"'
                className="w-full px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
              />
            </div>
            <button
              onClick={() => activeFloor != null && handleDeleteFloor(activeFloor)}
              className="flex items-center gap-1 px-2 py-1.5 text-[9px] font-bold"
              style={{ color: PALETTE.occupied }}
            >
              <Trash2 size={11} /> DELETE FLOOR
            </button>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <button
              onClick={openCreateForm}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold"
              style={{ background: "#111110", color: "#F0EDE6" }}
            >
              <Table2 size={11} /> ADD TABLE
            </button>
            <button
              onClick={handleAddSeatButton}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold"
              style={{ background: OBJECT_COLOR.seat, color: "#fff" }}
            >
              <Armchair size={11} /> ADD SEAT {selectedTable ? `TO ${selectedTable.name || selectedTable.id}` : ""}
            </button>
            <button
              onClick={openCreateAmenityForm}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold"
              style={{ background: OBJECT_COLOR.amenity, color: "#fff" }}
            >
              <MapPin size={11} /> ADD AMENITY
            </button>
            <button
              disabled={!selection}
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold disabled:opacity-30"
              style={{ background: `${PALETTE.occupied}18`, color: PALETTE.occupied }}
            >
              <Trash2 size={11} /> DELETE SELECTED
            </button>
            <div className="flex-1" />
            <button
              disabled={historyIndex <= 0}
              onClick={undo}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold disabled:opacity-30"
              style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.6)" }}
            >
              <Undo2 size={11} /> UNDO
            </button>
            <button
              disabled={historyIndex >= history.length - 1}
              onClick={redo}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold disabled:opacity-30"
              style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.6)" }}
            >
              <Redo2 size={11} /> REDO
            </button>
          </div>

          <div className="flex gap-4">
            {/* Canvas */}
            <div className="flex-1">
              {floorTables.length === 0 && (
                <div className="mb-2 px-3 py-2 text-[10px]" style={{ background: "rgba(200,168,75,0.1)", color: "#8a6f2e" }}>
                  This floor has no tables yet — click "Add Table" to place your first one.
                </div>
              )}
              <svg
                ref={svgRef}
                viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
                className="w-full border border-border"
                style={{ background: "#FAFAF8", display: "block" }}
                onMouseDown={() => setSelection(null)}
              >
                {floorObjects.filter(o => o.type === "table").map(table => {
                  const isSelected = selection?.type === "table" && selection.id === table.id;
                  const seatCount = objects.filter(o => o.type === "seat" && o.tableId === table.id).length;
                  const { text: nameLabel, fontSize: nameFontSize } = fitLabel(table.name || "Table", table.width, 9, 7);
                  const { text: countLabel, fontSize: countFontSize } = fitLabel(`${seatCount} seat${seatCount !== 1 ? "s" : ""}`, table.width, 7, 6);
                  return (
                    <g key={table.id} onMouseDown={e => handleMouseDown(table, e)} style={{ cursor: "grab" }}>
                      <rect
                        x={table.x} y={table.y} width={table.width} height={table.height} rx={6}
                        fill={OBJECT_COLOR.table} fillOpacity={0.14}
                        stroke={isSelected ? PALETTE.gold : OBJECT_COLOR.table}
                        strokeWidth={isSelected ? 2.5 : 1.5}
                      />
                      <text
                        x={table.x + table.width / 2} y={table.y + table.height / 2 - 3}
                        fontSize={nameFontSize} fontFamily="'JetBrains Mono', monospace" fontWeight="700"
                        fill={OBJECT_COLOR.table} textAnchor="middle" dominantBaseline="central"
                      >
                        {nameLabel}
                      </text>
                      <text
                        x={table.x + table.width / 2} y={table.y + table.height / 2 + 10}
                        fontSize={countFontSize} fontFamily="'JetBrains Mono', monospace"
                        fill="currentColor" fillOpacity={0.4} textAnchor="middle" dominantBaseline="central"
                      >
                        {countLabel}
                      </text>
                    </g>
                  );
                })}

                {floorObjects.filter(o => o.type === "seat").map(seat => {
                  const isSelected = selection?.type === "seat" && selection.id === seat.id;
                  const isAvailable = seat.occupancyStatus === "available";
                  const { text: seatLabel, fontSize: seatFontSize } = fitLabel(seat.id.slice(seat.id.lastIndexOf("-") + 1), seat.width, 6.5, 5.5);
                  return (
                    <g key={seat.id} onMouseDown={e => handleMouseDown(seat, e)} style={{ cursor: "grab" }}>
                      <rect
                        x={seat.x} y={seat.y} width={seat.width} height={seat.height} rx={4}
                        fill={isAvailable ? PALETTE.available : PALETTE.occupied} fillOpacity={0.25}
                        stroke={isSelected ? PALETTE.gold : (isAvailable ? PALETTE.available : PALETTE.occupied)}
                        strokeWidth={isSelected ? 2.5 : 1.25}
                      />
                      <text
                        x={seat.x + seat.width / 2} y={seat.y + seat.height / 2}
                        fontSize={seatFontSize} fontFamily="'JetBrains Mono', monospace" fontWeight="700"
                        fill={isAvailable ? PALETTE.available : PALETTE.occupied}
                        textAnchor="middle" dominantBaseline="central"
                      >
                        {seatLabel}
                      </text>
                    </g>
                  );
                })}

                {floorObjects.filter(o => o.type === "amenity").map(amenity => {
                  const isSelected = selection?.type === "amenity" && selection.id === amenity.id;
                  const abbr = AMENITY_ABBR[(amenity.amenityType as AmenityType) ?? "other"];
                  const { text: amenityLabel, fontSize: amenityFontSize } = fitLabel(abbr, amenity.width, 6.5, 5);
                  return (
                    <g key={amenity.id} onMouseDown={e => handleMouseDown(amenity, e)} style={{ cursor: "grab" }}>
                      <rect
                        x={amenity.x} y={amenity.y} width={amenity.width} height={amenity.height} rx={15}
                        fill={OBJECT_COLOR.amenity} fillOpacity={0.18}
                        stroke={isSelected ? PALETTE.gold : OBJECT_COLOR.amenity}
                        strokeWidth={isSelected ? 2.5 : 1.5}
                      />
                      <text
                        x={amenity.x + amenity.width / 2} y={amenity.y + amenity.height / 2}
                        fontSize={amenityFontSize} fontFamily="'JetBrains Mono', monospace" fontWeight="700"
                        fill={OBJECT_COLOR.amenity} textAnchor="middle" dominantBaseline="central"
                      >
                        {amenityLabel}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* New-table form — covers everything from a single solo desk to a
                custom-sized lounge/seminar room with several seats at once. */}
            {creatingTable && (
              <div className="w-56 flex-shrink-0 border border-border p-4" style={{ background: "#FFFFFF" }}>
                <SectionTitle>NEW TABLE</SectionTitle>
                <div className="flex flex-col gap-2 mb-4">
                  <input
                    value={draft.name}
                    onChange={e => setDraft({ ...draft, name: e.target.value })}
                    placeholder='Name, e.g. "Lounge Area"'
                    autoFocus
                    className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                  />
                  <div className="flex gap-2">
                    <label className="flex-1">
                      <div className="text-[8px] mb-1" style={{ color: "rgba(17,17,16,0.4)" }}>WIDTH</div>
                      <input
                        type="number" min={24} max={canvasWidth}
                        value={draft.width}
                        onChange={e => setDraft({ ...draft, width: parseInt(e.target.value, 10) || 0 })}
                        className="w-full px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                      />
                    </label>
                    <label className="flex-1">
                      <div className="text-[8px] mb-1" style={{ color: "rgba(17,17,16,0.4)" }}>HEIGHT</div>
                      <input
                        type="number" min={24} max={canvasHeight}
                        value={draft.height}
                        onChange={e => setDraft({ ...draft, height: parseInt(e.target.value, 10) || 0 })}
                        className="w-full px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                      />
                    </label>
                  </div>
                  <label>
                    <div className="text-[8px] mb-1" style={{ color: "rgba(17,17,16,0.4)" }}>NUMBER OF SEATS</div>
                    <input
                      type="number" min={0} max={24}
                      value={draft.seatCount}
                      onChange={e => setDraft({ ...draft, seatCount: parseInt(e.target.value, 10) || 0 })}
                      className="w-full px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                    />
                  </label>
                  <select
                    value={draft.zoneType}
                    onChange={e => setDraft({ ...draft, zoneType: e.target.value as ZoneType })}
                    className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                  >
                    <option value="quiet">Quiet</option>
                    <option value="collaborative">Collaborative</option>
                  </select>
                </div>

                <div className="text-[8px] tracking-[0.18em] mb-2" style={{ color: "rgba(17,17,16,0.35)" }}>EQUIPMENT</div>
                <div className="flex flex-col gap-1.5 mb-4">
                  {(["power_outlet", "projector"] as Equipment[]).map(item => (
                    <label key={item} className="flex items-center gap-2 text-[10px]">
                      <input
                        type="checkbox"
                        checked={draft.equipment.includes(item)}
                        onChange={() => toggleDraftEquipment(item)}
                      />
                      {item === "power_outlet" ? "Power outlet" : "Projector"}
                    </label>
                  ))}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleCreateTable}
                    className="flex-1 px-2.5 py-1.5 text-[9px] font-bold"
                    style={{ background: PALETTE.available, color: "#fff" }}
                  >
                    CREATE
                  </button>
                  <button
                    onClick={closeCreateForm}
                    className="px-2.5 py-1.5 text-[9px] font-bold"
                    style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.6)" }}
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            )}

            {/* New-amenity form — a map marker for non-seat facilities:
                toilets, exits, elevators, and the like. */}
            {creatingAmenity && (
              <div className="w-56 flex-shrink-0 border border-border p-4" style={{ background: "#FFFFFF" }}>
                <SectionTitle>NEW AMENITY</SectionTitle>
                <div className="flex flex-col gap-2 mb-4">
                  <select
                    value={amenityDraft.amenityType}
                    onChange={e => setAmenityDraft({ ...amenityDraft, amenityType: e.target.value as AmenityType })}
                    className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                  >
                    {AMENITY_TYPES.map(t => (
                      <option key={t} value={t}>{AMENITY_LABEL.en[t]}</option>
                    ))}
                  </select>
                  <input
                    value={amenityDraft.name}
                    onChange={e => setAmenityDraft({ ...amenityDraft, name: e.target.value })}
                    placeholder='Label, e.g. "2F Restroom" (optional)'
                    autoFocus
                    className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleCreateAmenity}
                    className="flex-1 px-2.5 py-1.5 text-[9px] font-bold"
                    style={{ background: OBJECT_COLOR.amenity, color: "#fff" }}
                  >
                    CREATE
                  </button>
                  <button
                    onClick={closeCreateAmenityForm}
                    className="px-2.5 py-1.5 text-[9px] font-bold"
                    style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.6)" }}
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            )}

            {/* Property panel */}
            {!creatingTable && !creatingAmenity && selectedTable && (
              <div className="w-56 flex-shrink-0 border border-border p-4" style={{ background: "#FFFFFF" }}>
                <SectionTitle>TABLE</SectionTitle>
                <div className="flex flex-col gap-2 mb-4">
                  <input
                    value={selectedTable.name}
                    onChange={e => updateSelectedTable({ name: e.target.value })}
                    onBlur={commitEdit}
                    placeholder="Name, e.g. Quiet Desk 1"
                    className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                  />
                  <input
                    value={selectedTable.location}
                    onChange={e => updateSelectedTable({ location: e.target.value })}
                    onBlur={commitEdit}
                    placeholder="Location, e.g. East wing, near window"
                    className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                  />
                  <select
                    value={selectedTable.zoneType}
                    onChange={e => {
                      const newObjects = objects.map(o => o.id === selectedTable.id ? { ...o, zoneType: e.target.value as ZoneType } : o);
                      commit(floors, newObjects);
                    }}
                    className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                  >
                    <option value="quiet">Quiet</option>
                    <option value="collaborative">Collaborative</option>
                  </select>
                </div>

                <div className="text-[8px] tracking-[0.18em] mb-2" style={{ color: "rgba(17,17,16,0.35)" }}>EQUIPMENT</div>
                <div className="flex flex-col gap-1.5 mb-4">
                  {(["power_outlet", "projector"] as Equipment[]).map(item => (
                    <label key={item} className="flex items-center gap-2 text-[10px]">
                      <input
                        type="checkbox"
                        checked={selectedTable.equipment.includes(item)}
                        onChange={() => toggleEquipment(item)}
                      />
                      {item === "power_outlet" ? "Power outlet" : "Projector"}
                    </label>
                  ))}
                </div>

                <div className="text-[8px] tracking-[0.18em] mb-2" style={{ color: "rgba(17,17,16,0.35)" }}>
                  SEATS ({selectedTableSeats.length})
                </div>
                <div className="flex flex-col gap-1 mb-3">
                  {selectedTableSeats.map(seat => (
                    <div key={seat.id} className="flex items-center justify-between text-[9px]">
                      <span>{seat.id.slice(seat.id.lastIndexOf("-") + 1)} · {seat.occupancyStatus}</span>
                      <button
                        onClick={() => commit(floors, objects.filter(o => o.id !== seat.id))}
                        style={{ color: PALETTE.occupied }}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                  {selectedTableSeats.length === 0 && (
                    <div className="text-[9px]" style={{ color: "rgba(17,17,16,0.35)" }}>No seats yet.</div>
                  )}
                </div>
                <button
                  onClick={() => handleAddSeat(selectedTable.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[9px] font-bold w-full justify-center"
                  style={{ background: OBJECT_COLOR.seat, color: "#fff" }}
                >
                  <Plus size={10} /> ADD SEAT
                </button>
              </div>
            )}

            {/* Amenity property panel */}
            {!creatingTable && !creatingAmenity && selectedAmenity && (
              <div className="w-56 flex-shrink-0 border border-border p-4" style={{ background: "#FFFFFF" }}>
                <SectionTitle>AMENITY</SectionTitle>
                <div className="flex flex-col gap-2 mb-4">
                  <select
                    value={selectedAmenity.amenityType ?? "other"}
                    onChange={e => {
                      const newObjects = objects.map(o => o.id === selectedAmenity.id ? { ...o, amenityType: e.target.value as AmenityType } : o);
                      commit(floors, newObjects);
                    }}
                    className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                  >
                    {AMENITY_TYPES.map(t => (
                      <option key={t} value={t}>{AMENITY_LABEL.en[t]}</option>
                    ))}
                  </select>
                  <input
                    value={selectedAmenity.name}
                    onChange={e => updateSelectedAmenity({ name: e.target.value })}
                    onBlur={commitEdit}
                    placeholder="Label, e.g. 2F Restroom"
                    className="px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                  />
                </div>
                <button
                  onClick={handleDelete}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[9px] font-bold w-full justify-center"
                  style={{ background: `${PALETTE.occupied}18`, color: PALETTE.occupied }}
                >
                  <Trash2 size={10} /> DELETE
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              disabled={saving}
              onClick={handleSave}
              className="px-3 py-2 text-[9px] font-bold disabled:opacity-40"
              style={{ background: PALETTE.available, color: "#fff" }}
            >
              {saving ? "SAVING…" : "SAVE FLOOR PLAN"}
            </button>
            {saveMessage && <span className="text-[10px]" style={{ color: PALETTE.available }}>{saveMessage}</span>}
          </div>
        </>
      )}
    </div>
  );
}
