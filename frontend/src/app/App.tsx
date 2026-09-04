import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Link } from "react-router";
import {
  Zap, Projector,
  X, Sparkles, Clock, Send, CornerDownLeft, AlertTriangle, ArrowLeft, Languages, HelpCircle, MapPin, RefreshCw,
  LogIn, LogOut, Trophy, FlaskConical, MoreHorizontal, ChevronUp, Info,
  type LucideIcon,
} from "lucide-react";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import {
  fetchSeats, fetchFloors, fetchAmenities, recommendSeat,
  fetchChairs, checkIn, confirmCheckIn, checkOut, fetchPoints, fetchLeaderboard,
  type Seat, type Intent, type Equipment, type ZoneType, type MatchType, type FloorMeta, type Amenity, type Chair,
} from "./api";
import { PALETTE, fitFontSize, fitLabel, DEFAULT_SEAT_SIZE, AMENITY_ABBR } from "./constants";
import { type Lang, UI, ZONE_LABEL, EQUIPMENT_LABEL, EXAMPLE_PROMPTS, AMENITY_LABEL, useLang } from "./i18n";
import { ErrorBanner } from "./ui";

const STUDENT_ONBOARDED_KEY = "findaspot_onboarded_finder";
const PRIVACY_ACK_KEY = "findaspot_privacy_ack";
const CHECKIN_KEY = "findaspot_checkin";
const NICKNAME_KEY = "findaspot_nickname";
// Mirrors api/server.py's CHECKIN_GRACE_MINUTES — how long past expiry an
// unconfirmed check-in is allowed to keep a seat marked occupied before the
// server auto-releases it. Used here only to decide when to stop trusting a
// locally-cached check-in and quietly drop it.
const CHECKIN_GRACE_MINUTES = 15;
// How often the finder re-checks seat status while a recommendation is on
// screen, so a seat taken in the meantime (by another student, or by camera
// detection) surfaces without the student having to hit refresh.
const SEAT_POLL_MS = 3000;

interface MyCheckIn {
  checkinId: string;
  seatId: string;
  tableId: string;
  seatName: string;
  expiresAt: string;
  durationMinutes: number;
}

interface PromptResult {
  query: string;
  intent: Intent;
  seats: Seat[];
  matchType: MatchType;
}

const EQUIPMENT_ICON: Record<Equipment, LucideIcon> = {
  power_outlet: Zap,
  projector: Projector,
};

function seatName(seat: Seat, lang: Lang): string {
  return lang === "zh" ? (seat.name_zh || seat.name_en) : seat.name_en;
}

function seatLocation(seat: Seat, lang: Lang): string {
  return lang === "zh" ? (seat.location_zh || seat.location_en) : seat.location_en;
}

/** Fill color for a seat/table on the map — a third amber state for
 * "partially occupied" closes the loop on per-chair granularity: a table
 * with 1 of 4 seats free shouldn't render identically to a fully-empty one. */
function seatDisplayColor(seat: Seat): string {
  if (seat.occupancyStatus === "occupied") return PALETTE.occupied;
  if (seat.availableSeats != null && seat.capacity > 1 && seat.availableSeats < seat.capacity) return PALETTE.gold;
  return PALETTE.available;
}

function seatStatusLabel(seat: Seat, lang: Lang): string {
  const t = UI[lang];
  if (seat.capacity > 1 && seat.availableSeats != null) {
    return t.freeCount(seat.availableSeats, seat.capacity);
  }
  return seat.occupancyStatus === "available" ? t.available.toLowerCase() : t.occupied.toLowerCase();
}

/** "near the stairs" / "away from the toilet" — null when the query had no
 * amenity-proximity preference. A soft tie-break, not a hard requirement,
 * so it's described but never counted as "missing" on an alternative match. */
function proximityDesc(intent: Intent, lang: Lang): string | null {
  const t = UI[lang];
  if (intent.nearAmenity) return t.nearAmenityDesc(AMENITY_LABEL[lang][intent.nearAmenity]);
  if (intent.farAmenity) return t.farAmenityDesc(AMENITY_LABEL[lang][intent.farAmenity]);
  return null;
}

/** Summarizes the whole result set (buildReply) rather than a single pick —
 * the map + result list below show each seat's own detail, so this sentence
 * only needs to say how many qualified and why. */
function buildReply(matchType: MatchType, seats: Seat[], intent: Intent, lang: Lang): string {
  const t = UI[lang];
  const proximity = proximityDesc(intent, lang);
  const reqDesc = [
    ZONE_LABEL[lang][intent.zoneType],
    ...intent.requiredEquipment.map(e => EQUIPMENT_LABEL[lang][e]),
    ...(proximity ? [proximity] : []),
  ].join(", ");

  if (matchType === "none" || seats.length === 0) {
    return t.noneAvailable;
  }
  const top = seats[0];
  if (matchType === "perfect") {
    return seats.length === 1
      ? t.perfectMatch(seatName(top, lang), top.floor, reqDesc)
      : t.perfectMatches(seats.length, reqDesc);
  }
  const missing: string[] = [];
  const available = top.availableSeats ?? (top.occupancyStatus === "available" ? top.capacity : 0);
  if (top.zoneType !== intent.zoneType) missing.push(ZONE_LABEL[lang][intent.zoneType]);
  if (available < intent.groupSize) missing.push(t.seatingFor(intent.groupSize));
  if (intent.floor != null && top.floor !== intent.floor) missing.push(t.floorN(intent.floor));
  for (const e of intent.requiredEquipment) {
    if (!top.equipment.includes(e)) missing.push(EQUIPMENT_LABEL[lang][e]);
  }
  return seats.length === 1
    ? t.altMatch(seatName(top, lang), top.floor, missing.join(", "))
    : t.altMatches(seats.length, missing.join(", "));
}

/** Union bounding box (with padding) for every seat of a given zone on this floor, for the outline overlay. */
function zoneBounds(seats: Seat[], zoneType: ZoneType) {
  const zoneSeats = seats.filter(s => s.zoneType === zoneType);
  if (zoneSeats.length === 0) return null;
  const pad = 16;
  const x0 = Math.min(...zoneSeats.map(s => s.bbox[0])) - pad;
  const y0 = Math.min(...zoneSeats.map(s => s.bbox[1])) - pad;
  const x1 = Math.max(...zoneSeats.map(s => s.bbox[0] + s.bbox[2])) + pad;
  const y1 = Math.max(...zoneSeats.map(s => s.bbox[1] + s.bbox[3])) + pad;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export default function App() {
  const [lang, toggleLang] = useLang();
  const t = UI[lang];

  const [showPrivacyNotice, setShowPrivacyNotice] = useState(() => !localStorage.getItem(PRIVACY_ACK_KEY));

  const dismissPrivacyNotice = () => {
    localStorage.setItem(PRIVACY_ACK_KEY, "1");
    setShowPrivacyNotice(false);
  };

  const startTour = useCallback(() => {
    const tourDriver = driver({
      showProgress: true,
      allowClose: true,
      popoverClass: "findaspot-tour",
      nextBtnText: t.tourNext,
      prevBtnText: t.tourPrev,
      doneBtnText: t.tourDone,
      onDestroyStarted: () => {
        localStorage.setItem(STUDENT_ONBOARDED_KEY, "1");
        tourDriver.destroy();
      },
      steps: [
        { popover: { title: t.tourStudentWelcomeTitle, description: t.tourStudentWelcomeDesc } },
        { element: "#tour-floor-select", popover: { title: t.tourFloorTitle, description: t.tourFloorDesc, side: "right" } },
        { element: "#tour-examples", popover: { title: t.tourExamplesTitle, description: t.tourExamplesDesc, side: "right" } },
        { element: "#tour-prompt-input", popover: { title: t.tourPromptTitle, description: t.tourPromptDesc, side: "bottom" } },
        { element: "#tour-legend", popover: { title: t.tourLegendTitle, description: t.tourLegendDesc, side: "right" } },
        { popover: { title: t.tourCheckInTitle, description: t.tourCheckInDesc } },
        { element: "#tour-more-menu", popover: { title: t.tourMoreMenuTitle, description: t.tourMoreMenuDesc, side: "top" } },
        { element: "#tour-lang-toggle", popover: { title: t.tourLangTitle, description: t.tourLangDesc, side: "bottom" } },
      ],
    });
    tourDriver.drive();
  }, [t]);

  // Guided tour runs once per browser, the first time a student lands here —
  // held off until the privacy notice (if shown) is dismissed, so the two
  // overlays never stack.
  useEffect(() => {
    if (showPrivacyNotice) return;
    if (!localStorage.getItem(STUDENT_ONBOARDED_KEY)) {
      const id = setTimeout(startTour, 600);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPrivacyNotice]);

  const [seats, setSeats]               = useState<Seat[]>([]);
  const [seatsLoading, setSeatsLoading]  = useState(true);
  const [seatsError, setSeatsError]      = useState<string | null>(null);

  const [floors, setFloors]             = useState<FloorMeta[]>([]);
  const [floor, setFloor]               = useState<number>(1);
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [promptInput, setPromptInput]   = useState("");
  const [promptResult, setPromptResult] = useState<PromptResult | null>(null);
  const [isTyping, setIsTyping]         = useState(false);
  const [submitError, setSubmitError]   = useState<string | null>(null);
  const [refreshing, setRefreshing]     = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mapSvgRef = useRef<SVGSVGElement>(null);

  const [amenities, setAmenities]       = useState<Amenity[]>([]);
  const [myPin, setMyPin]               = useState<{ x: number; y: number } | null>(null);
  const [placingPin, setPlacingPin]     = useState(false);

  // ── Self check-in (beta): camera-free, no-login occupancy self-report ──
  const [myCheckIn, setMyCheckIn] = useState<MyCheckIn | null>(() => {
    try { return JSON.parse(localStorage.getItem(CHECKIN_KEY) || "null"); } catch { return null; }
  });
  const [nickname, setNickname] = useState(() => localStorage.getItem(NICKNAME_KEY) || "");
  const [myPoints, setMyPoints] = useState<number | null>(null);
  const [checkInForm, setCheckInForm] = useState<{ tableId: string; tableName: string; chairs: Chair[] } | null>(null);
  const [checkInChairId, setCheckInChairId] = useState<string | null>(null);
  const [checkInDuration, setCheckInDuration] = useState<60 | 120>(60);
  const [checkInBusy, setCheckInBusy] = useState(false);
  const [checkInError, setCheckInError] = useState<string | null>(null);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [leaderboard, setLeaderboard] = useState<{ nickname: string; points: number }[]>([]);
  const [checkInTick, setCheckInTick] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setCheckInTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const persistCheckIn = (c: MyCheckIn | null) => {
    setMyCheckIn(c);
    if (c) localStorage.setItem(CHECKIN_KEY, JSON.stringify(c));
    else localStorage.removeItem(CHECKIN_KEY);
  };

  const persistNickname = (n: string) => {
    setNickname(n);
    localStorage.setItem(NICKNAME_KEY, n);
  };

  // A check-in past expiry + the server's grace period is assumed
  // auto-released server-side — quietly drop the stale local copy rather
  // than keep offering a "check out" button for a seat we no longer hold.
  useEffect(() => {
    if (!myCheckIn) return;
    const graceDeadline = new Date(myCheckIn.expiresAt).getTime() + CHECKIN_GRACE_MINUTES * 60000;
    if (checkInTick > graceDeadline) {
      persistCheckIn(null);
      loadSeats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkInTick, myCheckIn]);

  useEffect(() => {
    if (!nickname) { setMyPoints(null); return; }
    fetchPoints(nickname).then(setMyPoints).catch(() => {});
  }, [nickname, myCheckIn]);

  const openCheckInForm = async (tableId: string, tableName: string) => {
    setCheckInError(null);
    try {
      const chairs = await fetchChairs(tableId);
      const available = chairs.filter(c => c.occupancyStatus === "available");
      setCheckInForm({ tableId, tableName, chairs: available });
      setCheckInChairId(available[0]?.id ?? null);
    } catch (e: any) {
      setCheckInError(e.message);
    }
  };

  const submitCheckIn = async () => {
    if (!checkInChairId) return;
    setCheckInBusy(true);
    setCheckInError(null);
    try {
      const result = await checkIn(checkInChairId, checkInDuration, nickname || null);
      persistCheckIn({
        checkinId: result.checkinId,
        seatId: result.seatId,
        tableId: checkInForm!.tableId,
        seatName: checkInForm!.tableName,
        expiresAt: result.expiresAt,
        durationMinutes: result.durationMinutes,
      });
      if (result.points != null) setMyPoints(result.points);
      setCheckInForm(null);
      loadSeats();
    } catch (e: any) {
      setCheckInError(e.message);
    } finally {
      setCheckInBusy(false);
    }
  };

  const handleStillHere = async () => {
    if (!myCheckIn) return;
    try {
      const res = await confirmCheckIn(myCheckIn.checkinId);
      persistCheckIn({ ...myCheckIn, expiresAt: res.expiresAt });
      if (res.points != null) setMyPoints(res.points);
    } catch {
      persistCheckIn(null);
      loadSeats();
    }
  };

  const handleCheckOut = async () => {
    if (!myCheckIn) return;
    try {
      const res = await checkOut(myCheckIn.checkinId);
      if (res.points != null) setMyPoints(res.points);
    } catch {
      // Already gone server-side (expired/removed) — fine, we're clearing it either way.
    } finally {
      persistCheckIn(null);
      loadSeats();
    }
  };

  const openLeaderboard = () => {
    setShowLeaderboard(true);
    fetchLeaderboard().then(setLeaderboard).catch(() => {});
  };

  const checkInExpiresInMinutes = myCheckIn ? Math.round((new Date(myCheckIn.expiresAt).getTime() - checkInTick) / 60000) : 0;
  const checkInIsStale = myCheckIn ? checkInTick > new Date(myCheckIn.expiresAt).getTime() : false;

  const loadSeats = useCallback(() => {
    setSeatsLoading(true);
    setSeatsError(null);
    fetchSeats()
      .then(setSeats)
      .catch(() => setSeatsError(t.backendDown))
      .finally(() => setSeatsLoading(false));
  }, [t.backendDown]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadSeats();
    } finally {
      setRefreshing(false);
    }
  }, [loadSeats]);

  useEffect(() => { loadSeats(); }, [loadSeats]);

  // ── Live seat status while a recommendation is showing ──────────────
  // The seat the student is actually heading to: whichever recommended seat
  // they've picked, else the top recommendation.
  const watchedSeat = useMemo(() => {
    if (!promptResult || promptResult.seats.length === 0) return null;
    return promptResult.seats.find(s => s.id === selectedId) ?? promptResult.seats[0];
  }, [promptResult, selectedId]);

  // That same seat as of the latest poll.
  const watchedLive = useMemo(
    () => (watchedSeat ? seats.find(s => s.id === watchedSeat.id) ?? null : null),
    [seats, watchedSeat],
  );

  // Derived rather than stored: it's simply "the live status differs from the
  // status this seat had when we recommended it". No refs to keep in sync, and
  // it clears itself the moment a fresh recommendation lands.
  const seatStatusChanged =
    !!watchedSeat && !!watchedLive &&
    watchedLive.occupancyStatus !== watchedSeat.occupancyStatus;

  // Refresh seats in the background — no spinner, this shouldn't feel like a load.
  const silentPoll = useCallback(async () => {
    try {
      setSeats(await fetchSeats());
    } catch {
      // ignore; the next tick retries
    }
  }, []);

  useEffect(() => {
    if (!watchedSeat) return;
    const id = setInterval(silentPoll, SEAT_POLL_MS);
    return () => clearInterval(id);
  }, [watchedSeat?.id, silentPoll]);

  useEffect(() => {
    fetchFloors().then(fs => {
      setFloors(fs);
      if (fs.length > 0) setFloor(prev => (fs.some(f => f.number === prev) ? prev : fs[0].number));
    }).catch(() => { /* finder still works without floor labels; floor buttons just won't render */ });
  }, []);

  useEffect(() => {
    fetchAmenities().then(setAmenities).catch(() => { /* map still works without amenity markers */ });
  }, []);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const floorSeats = useMemo(() => seats.filter(s => s.floor === floor), [seats, floor]);
  const floorAmenities = useMemo(() => amenities.filter(a => a.floor === floor), [amenities, floor]);
  const currentFloorLabel = floors.find(f => f.number === floor)?.label ?? "";

  // Pin resets whenever the student changes floor — it's a same-screen,
  // same-moment self-report, not a saved location.
  useEffect(() => { setMyPin(null); setPlacingPin(false); }, [floor]);

  const toSvgPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = mapSvgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const svgPt = pt.matrixTransform(ctm.inverse());
    return { x: svgPt.x, y: svgPt.y };
  };

  const handleMapClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!placingPin) return;
    const pt = toSvgPoint(e.clientX, e.clientY);
    setMyPin(pt);
    setPlacingPin(false);
  };

  const distanceInSeatWidths = (x1: number, y1: number, x2: number, y2: number): number =>
    Math.round(Math.hypot(x2 - x1, y2 - y1) / DEFAULT_SEAT_SIZE);

  const activeIntent = promptResult?.intent ?? null;

  // The server's own match list is authoritative — including for
  // "alternative" results, which a client-side re-check against intent
  // fields alone can't identify (an alternative is, by definition, missing
  // something the intent asked for).
  const resultSeatIds = useMemo(() => new Set(promptResult?.seats.map(s => s.id) ?? []), [promptResult]);

  const selectedSeat = seats.find(s => s.id === selectedId) ?? null;

  const stats = useMemo(() => ({
    available: floorSeats.filter(s => s.occupancyStatus === "available").length,
    occupied:  floorSeats.filter(s => s.occupancyStatus === "occupied").length,
  }), [floorSeats]);

  const totalSeats = stats.available + stats.occupied;
  const availPct   = totalSeats > 0 ? Math.round((stats.available / totalSeats) * 100) : 0;

  const zoneOverlays = useMemo(
    () => (["quiet", "collaborative"] as ZoneType[])
      .map(z => ({ zoneType: z, bounds: zoneBounds(floorSeats, z) }))
      .filter((z): z is { zoneType: ZoneType; bounds: NonNullable<ReturnType<typeof zoneBounds>> } => z.bounds !== null),
    [floorSeats]
  );

  const handleSubmit = async () => {
    const q = promptInput.trim();
    if (!q) return;
    setPromptInput("");
    setIsTyping(true);
    setSubmitError(null);
    try {
      const result = await recommendSeat(q, lang);
      setPromptResult({ query: q, intent: result.intent, seats: result.seats, matchType: result.matchType });
      if (result.seats.length > 0) {
        setFloor(result.seats[0].floor);
        setSelectedId(result.seats[0].id);
      } else {
        setSelectedId(null);
      }
    } catch {
      setSubmitError(t.recommendDown);
    } finally {
      setIsTyping(false);
    }
  };

  // Re-run the same query. Offered when the seat we sent the student to gets
  // taken out from under them — better than making them retype it.
  const handleRerun = useCallback(async () => {
    const q = promptResult?.query;
    if (!q) return;
    setIsTyping(true);
    setSubmitError(null);
    try {
      const result = await recommendSeat(q, lang);
      setPromptResult({ query: q, intent: result.intent, seats: result.seats, matchType: result.matchType });
      if (result.seats.length > 0) {
        setFloor(result.seats[0].floor);
        setSelectedId(result.seats[0].id);
      } else {
        setSelectedId(null);
      }
    } catch {
      setSubmitError(t.recommendDown);
    } finally {
      setIsTyping(false);
    }
  }, [promptResult?.query, lang, t.recommendDown]);

  const handleExample = (ex: string) => {
    setPromptInput(ex);
    inputRef.current?.focus();
  };

  const handleClearPrompt = () => {
    setPromptResult(null);
    setSubmitError(null);
    setSelectedId(null);
    setPromptInput("");
  };

  const handleFloorChange = (f: number) => {
    setFloor(f);
    setSelectedId(null);
  };

  const handleSeatClick = (seat: Seat) => {
    // While placing the "where am I" pin, a click on a seat should only
    // drop the pin there (handleMapClick, which also fires — the seat's
    // <g> is nested inside the map <svg>) — not also pop open that seat's
    // info card and bury the pin/distance feedback underneath it.
    if (placingPin) return;
    setSelectedId(prev => prev === seat.id ? null : seat.id);
  };

  return (
    <div
      className="size-full flex bg-background text-foreground overflow-hidden"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* ── PRIVACY NOTICE ───────────────────────────
          Shown once per browser, before the guided tour, blocking until
          dismissed — a trust disclosure, not a dismiss-and-forget toast. */}
      {showPrivacyNotice && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" style={{ background: "rgba(17,17,16,0.5)" }}>
          <div
            className="w-full max-w-sm border border-border animate-in fade-in-0 zoom-in-95 duration-150"
            style={{ background: "#FAFAF8", fontFamily: "'JetBrains Mono', monospace" }}
          >
            <div className="px-5 pt-5 pb-4">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={13} style={{ color: "#C8A84B" }} />
                <span className="text-xs font-bold tracking-widest">{t.privacyTitle}</span>
              </div>
              <div className="text-[10px] leading-relaxed" style={{ color: "rgba(17,17,16,0.6)" }}>
                {t.privacyBody}
              </div>
            </div>
            <button
              onClick={dismissPrivacyNotice}
              className="w-full py-3 text-[10px] font-bold tracking-widest transition-opacity hover:opacity-90"
              style={{ background: "#111110", color: "#F0EDE6" }}
            >
              {t.privacyAck}
            </button>
          </div>
        </div>
      )}

      {/* ── SIDEBAR ───────────────────────────────── */}
      <aside
        className="w-56 flex-shrink-0 flex flex-col border-r border-border overflow-y-auto"
        style={{ background: "#111110", color: "#F0EDE6", scrollbarWidth: "none" }}
      >
        {/* Brand */}
        <div className="px-5 pt-6 pb-4 border-b" style={{ borderColor: "rgba(240,237,230,0.08)" }}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[8px] tracking-[0.22em] mb-1" style={{ color: "rgba(240,237,230,0.3)" }}>
                DALIAN NEUSOFT UNIV. OF INFO.
              </div>
              <div className="text-sm font-bold tracking-widest leading-none">SEAT FINDER</div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={startTour}
                title={t.tourReplay}
                className="flex items-center px-1.5 py-1 text-[9px] font-bold transition-colors"
                style={{ background: "rgba(240,237,230,0.08)", color: "#F0EDE6" }}
              >
                <HelpCircle size={10} />
              </button>
              <button
                id="tour-lang-toggle"
                onClick={toggleLang}
                className="flex items-center gap-1 px-2 py-1 text-[9px] font-bold transition-colors"
                style={{ background: "rgba(240,237,230,0.08)", color: "#F0EDE6" }}
                title={lang === "en" ? "切换到中文" : "Switch to English"}
              >
                <Languages size={10} /> {t.langToggleLabel}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1 text-[9px] mt-2" style={{ color: "rgba(240,237,230,0.38)" }}>
            <Sparkles size={9} />
            {t.brandSub}
          </div>
        </div>

        {/* Floor select */}
        <div id="tour-floor-select" className="px-5 py-4 border-b" style={{ borderColor: "rgba(240,237,230,0.08)" }}>
          <div className="text-[8px] tracking-[0.22em] mb-3" style={{ color: "rgba(240,237,230,0.3)" }}>{t.floorHeading}</div>
          {floors.length > 0 ? (
            <>
              <div className="flex gap-1">
                {floors.map(f => (
                  <button
                    key={f.number}
                    onClick={() => handleFloorChange(f.number)}
                    className="flex-1 py-2 text-xs font-bold transition-colors"
                    style={{
                      background: floor === f.number ? "#F0EDE6" : "rgba(240,237,230,0.07)",
                      color: floor === f.number ? "#111110" : "rgba(240,237,230,0.45)",
                    }}
                  >
                    {f.number}
                  </button>
                ))}
              </div>
              {currentFloorLabel && (
                <div className="text-[8px] mt-2 leading-relaxed" style={{ color: "rgba(240,237,230,0.28)" }}>
                  {currentFloorLabel}
                </div>
              )}
            </>
          ) : (
            <div className="text-[8px] leading-relaxed" style={{ color: "rgba(240,237,230,0.28)" }}>
              {t.noFloors}
            </div>
          )}
        </div>

        {/* Try asking */}
        <div id="tour-examples" className="px-5 py-4 border-b" style={{ borderColor: "rgba(240,237,230,0.08)" }}>
          <div className="text-[8px] tracking-[0.22em] mb-3" style={{ color: "rgba(240,237,230,0.3)" }}>{t.tryAsking}</div>
          <div className="flex flex-col gap-1.5">
            {EXAMPLE_PROMPTS[lang].map(ex => (
              <button
                key={ex}
                onClick={() => handleExample(ex)}
                className="text-left text-[9px] px-3 py-2 transition-colors leading-snug"
                style={{
                  background: "rgba(240,237,230,0.05)",
                  color: "rgba(240,237,230,0.5)",
                }}
              >
                "{ex}"
              </button>
            ))}
          </div>
        </div>

        {/* Active result summary */}
        {promptResult && (
          <div
            className="px-5 py-4 border-b"
            style={{ borderColor: "rgba(240,237,230,0.08)", background: "rgba(200,168,75,0.07)" }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5 text-[8px] tracking-[0.18em]" style={{ color: "#C8A84B" }}>
                <Sparkles size={8} /> {t.lastResult}
              </div>
              <button onClick={handleClearPrompt} style={{ color: "rgba(240,237,230,0.3)" }}>
                <X size={10} />
              </button>
            </div>
            <div className="text-[9px] leading-relaxed" style={{ color: "rgba(240,237,230,0.55)" }}>
              "{promptResult.query}"
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              <span
                className="text-[8px] px-1.5 py-0.5 font-bold"
                style={{ background: "#C8A84B22", color: "#C8A84B" }}
              >
                {ZONE_LABEL[lang][promptResult.intent.zoneType]}
              </span>
              {promptResult.intent.groupSize > 1 && (
                <span
                  className="text-[8px] px-1.5 py-0.5 font-bold"
                  style={{ background: "#C8A84B22", color: "#C8A84B" }}
                >
                  {t.groupOf(promptResult.intent.groupSize)}
                </span>
              )}
              {promptResult.intent.requiredEquipment.map(e => (
                <span
                  key={e}
                  className="text-[8px] px-1.5 py-0.5 font-bold"
                  style={{ background: "#C8A84B22", color: "#C8A84B" }}
                >
                  {EQUIPMENT_LABEL[lang][e]}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="px-5 py-4 mt-auto">
          <div className="text-[8px] tracking-[0.22em] mb-3" style={{ color: "rgba(240,237,230,0.3)" }}>{t.availability}</div>
          <div className="flex flex-col gap-2">
            {[
              { label: t.available, count: stats.available, color: "#3D8B5E" },
              { label: t.occupied,  count: stats.occupied,  color: "#B94040" },
            ].map(({ label, count, color }) => (
              <div key={label} className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[9px]" style={{ color: "rgba(240,237,230,0.45)" }}>
                  <div className="w-2 h-2" style={{ background: color }} />
                  {label}
                </div>
                <span className="text-[10px] font-bold" style={{ color }}>{count}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 h-px w-full" style={{ background: "rgba(240,237,230,0.1)" }}>
            <div className="h-full transition-all" style={{ width: `${availPct}%`, background: "#3D8B5E" }} />
          </div>
          <div className="mt-1.5 text-[8px]" style={{ color: "rgba(240,237,230,0.22)" }}>
            {t.pctFreeOnFloor(availPct, totalSeats)}
          </div>
        </div>

        {/* Legend */}
        <div id="tour-legend" className="px-5 py-4 border-t" style={{ borderColor: "rgba(240,237,230,0.08)" }}>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {[
              { label: t.available, color: "#3D8B5E" },
              { label: t.occupied,  color: "#B94040" },
              { label: t.amenities, color: PALETTE.amenity },
            ].map(({ label, color }) => (
              <div key={label} className="flex items-center gap-1.5 text-[8px]" style={{ color: "rgba(240,237,230,0.38)" }}>
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                {label}
              </div>
            ))}
          </div>
          <div className="mt-2 text-[8px]" style={{ color: "rgba(240,237,230,0.2)" }}>
            {t.equipmentLegend}
          </div>

          {/* Everything below is secondary/occasional — tucked behind one
              menu instead of stacked as permanent links, so the sidebar
              doesn't feel crowded. */}
          <div className="mt-3 pt-3 border-t relative" style={{ borderColor: "rgba(240,237,230,0.08)" }}>
            <button
              id="tour-more-menu"
              onClick={() => setMoreMenuOpen(v => !v)}
              className="flex items-center gap-1.5 text-[9px] font-bold transition-opacity hover:opacity-70"
              style={{ color: "rgba(240,237,230,0.5)" }}
            >
              <MoreHorizontal size={12} /> {t.moreMenu} <ChevronUp size={10} style={{ transform: moreMenuOpen ? "rotate(0deg)" : "rotate(180deg)", transition: "transform 0.15s" }} />
            </button>

            {moreMenuOpen && (
              <div
                className="absolute left-0 bottom-full mb-2 w-56 border animate-in fade-in-0 slide-in-from-bottom-2 duration-150 z-10"
                style={{ background: "#1a1a19", borderColor: "rgba(240,237,230,0.12)" }}
              >
                <div className="p-1.5">
                  {!myPin ? (
                    <button
                      onClick={() => { setPlacingPin(v => !v); setMoreMenuOpen(false); }}
                      className="w-full flex items-center gap-2 px-2.5 py-2 text-[9px] font-bold text-left transition-colors hover:bg-white/5"
                      style={{ color: placingPin ? PALETTE.gold : "rgba(240,237,230,0.7)" }}
                    >
                      <MapPin size={11} /> {placingPin ? t.whereAmIPlacing : t.whereAmI}
                    </button>
                  ) : (
                    <button
                      onClick={() => { setMyPin(null); setMoreMenuOpen(false); }}
                      className="w-full flex items-center gap-2 px-2.5 py-2 text-[9px] font-bold text-left transition-colors hover:bg-white/5"
                      style={{ color: PALETTE.gold }}
                    >
                      <X size={11} /> {t.whereAmIClear}
                    </button>
                  )}
                  <div className="px-2.5 pb-2 text-[8px] leading-relaxed" style={{ color: "rgba(240,237,230,0.28)" }}>
                    {t.whereAmIPrivacy}
                  </div>

                  <div className="my-1 h-px" style={{ background: "rgba(240,237,230,0.08)" }} />

                  <button
                    onClick={() => { openLeaderboard(); setMoreMenuOpen(false); }}
                    className="w-full flex items-center gap-2 px-2.5 py-2 text-[9px] font-bold text-left transition-colors hover:bg-white/5"
                    style={{ color: "rgba(240,237,230,0.7)" }}
                  >
                    <Trophy size={11} /> {t.leaderboardLink}
                  </button>
                  <Link
                    to="/faq?role=student"
                    className="flex items-center gap-2 px-2.5 py-2 text-[9px] font-bold transition-colors hover:bg-white/5"
                    style={{ color: "rgba(240,237,230,0.7)" }}
                  >
                    <HelpCircle size={11} /> {t.faqTitle}
                  </Link>
                  <Link
                    to="/"
                    className="flex items-center gap-2 px-2.5 py-2 text-[9px] font-bold transition-colors hover:bg-white/5"
                    style={{ color: "rgba(240,237,230,0.7)" }}
                  >
                    <ArrowLeft size={11} /> {t.backToHome}
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ── MAIN ──────────────────────────────────── */}
      <main className="flex-1 flex flex-col overflow-hidden bg-background">
        {/* Top bar */}
        <div className="flex items-center justify-between px-7 py-3 border-b border-border">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold">{t.floorLabel} {floor}</span>
            {currentFloorLabel && (
              <>
                <span className="text-[10px]" style={{ color: "rgba(17,17,16,0.3)" }}>·</span>
                <span className="text-[10px]" style={{ color: "rgba(17,17,16,0.45)" }}>{currentFloorLabel}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-[10px] px-2.5 py-1.5 transition-opacity hover:opacity-60 disabled:opacity-40"
              style={{ color: "rgba(17,17,16,0.5)", background: "rgba(17,17,16,0.04)" }}
              title={t.refreshSeats}
            >
              <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} />
              <span className="tracking-wide font-medium">
                {refreshing ? t.loadingSeats : t.refresh}
              </span>
            </button>
            <div className="flex items-center gap-2 text-[10px]" style={{ color: "rgba(17,17,16,0.4)" }}>
              <Clock size={10} />
              {now.toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}
              <span className="ml-1">
                {now.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { weekday: "short", month: "short", day: "numeric" })}
              </span>
            </div>
          </div>
        </div>

        {/* Self check-in status banner */}
        {myCheckIn && (
          <div
            className="flex items-center justify-between gap-3 px-7 py-2.5 border-b border-border text-[10px]"
            style={{ background: checkInIsStale ? "#C8A84B18" : "#3D8B5E0C", borderColor: "var(--border)" }}
          >
            {checkInIsStale ? (
              <>
                <span className="font-bold" style={{ color: "#8a6f2e" }}>
                  {t.stillHereQuestion(myCheckIn.seatName)}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleStillHere}
                    className="px-2.5 py-1 text-[9px] font-bold"
                    style={{ background: PALETTE.available, color: "#fff" }}
                  >
                    {t.yesStillHere}
                  </button>
                  <button
                    onClick={handleCheckOut}
                    className="px-2.5 py-1 text-[9px] font-bold"
                    style={{ background: "rgba(17,17,16,0.08)", color: "rgba(17,17,16,0.6)" }}
                  >
                    {t.noILeft}
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="flex items-center gap-2" style={{ color: "#2e6b46" }}>
                  <LogIn size={11} />
                  <span className="font-bold">{t.checkedInBanner(myCheckIn.seatName)}</span>
                  <span style={{ color: "rgba(17,17,16,0.4)" }}>· {t.expiresIn(Math.max(checkInExpiresInMinutes, 0))}</span>
                </span>
                <button
                  onClick={handleCheckOut}
                  className="flex items-center gap-1 px-2.5 py-1 text-[9px] font-bold transition-opacity hover:opacity-70"
                  style={{ color: "#2e6b46" }}
                >
                  <LogOut size={10} /> {t.checkOutBtn}
                </button>
              </>
            )}
          </div>
        )}

        {/* Prompt bar */}
        <div className="px-7 py-4 border-b border-border" style={{ background: "#FAFAF8" }}>
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={11} style={{ color: "#C8A84B" }} />
            <span className="text-[9px] tracking-[0.18em]" style={{ color: "rgba(17,17,16,0.4)" }}>
              {t.describeNeed}
            </span>
          </div>
          <div id="tour-prompt-input" className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={promptInput}
              onChange={e => setPromptInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              placeholder={t.promptPlaceholder}
              className="flex-1 px-3 py-2.5 text-[11px] border border-border bg-background outline-none transition-colors"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            />
            <button
              onClick={handleSubmit}
              disabled={!promptInput.trim() || isTyping}
              className="px-4 flex items-center gap-1.5 text-[9px] font-bold tracking-widest transition-opacity disabled:opacity-30"
              style={{ background: "#111110", color: "#F0EDE6" }}
            >
              {isTyping ? (
                <span className="animate-pulse">···</span>
              ) : (
                <>
                  <Send size={10} />
                  {t.ask}
                </>
              )}
            </button>
          </div>

          {/* AI reply / error */}
          {submitError && !isTyping && (
            <div
              className="mt-3 px-3 py-2.5 flex items-start gap-2.5 text-[10px] leading-relaxed"
              style={{ background: "#B940400C", borderLeft: "2px solid #B94040" }}
            >
              <AlertTriangle size={10} style={{ color: "#B94040", marginTop: 2, flexShrink: 0 }} />
              <span style={{ color: "rgba(17,17,16,0.7)" }}>{submitError}</span>
            </div>
          )}
          {promptResult && !isTyping && !submitError && (
            <div className="relative z-50 mt-3 px-3 py-2.5 text-[10px] leading-relaxed" style={{ background: "#3D8B5E0C", borderLeft: "2px solid #3D8B5E" }}>
              <div className="flex items-start gap-2.5">
                <Sparkles size={10} style={{ color: "#3D8B5E", marginTop: 2, flexShrink: 0 }} />
                <span style={{ color: "rgba(17,17,16,0.7)" }}>
                  {buildReply(promptResult.matchType, promptResult.seats, promptResult.intent, lang)}
                </span>
                {promptResult.seats.length === 1 && (
                  <button
                    onClick={() => setSelectedId(promptResult.seats[0].id)}
                    className="ml-auto flex-shrink-0 text-[9px] font-bold underline transition-opacity hover:opacity-60"
                    style={{ color: "#3D8B5E" }}
                  >
                    {t.view} {seatName(promptResult.seats[0], lang)}
                  </button>
                )}
              </div>

              {/* Every matching seat, browsable — a student picks whichever
                  suits them instead of being handed just one. */}
              {promptResult.seats.length > 1 && (
                <div className="flex gap-1.5 mt-2.5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
                  {promptResult.seats.map(s => {
                    const isPicked = s.id === selectedId;
                    const color = seatDisplayColor(s);
                    return (
                      <button
                        key={s.id}
                        onClick={() => { setFloor(s.floor); setSelectedId(s.id); }}
                        className="flex-shrink-0 flex flex-col items-start gap-0.5 px-2.5 py-1.5 text-left transition-colors"
                        style={{
                          background: isPicked ? "#111110" : "#FFFFFF",
                          border: `1px solid ${isPicked ? "#111110" : "rgba(17,17,16,0.12)"}`,
                        }}
                      >
                        <span className="flex items-center gap-1.5 text-[9px] font-bold" style={{ color: isPicked ? "#F0EDE6" : "rgba(17,17,16,0.8)" }}>
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
                          {seatName(s, lang)}
                        </span>
                        <span className="text-[8px]" style={{ color: isPicked ? "rgba(240,237,230,0.5)" : "rgba(17,17,16,0.4)" }}>
                          {t.floorN(s.floor)} · {seatStatusLabel(s, lang)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {/* The seat we sent them to changed status while they were looking at
              it — say so, and offer to find another without retyping. */}
          {seatStatusChanged && !isTyping && watchedLive && (
            <div
              className="relative z-50 mt-3 px-3 py-2.5 flex items-center gap-3 text-[10px] leading-relaxed"
              style={{ background: "#C8A84B10", borderLeft: "2px solid #C8A84B" }}
            >
              <Info size={10} style={{ color: "#C8A84B", flexShrink: 0 }} />
              <span style={{ color: "rgba(17,17,16,0.7)" }}>
                {t.seatStatusChanged(seatName(watchedLive, lang), seatStatusLabel(watchedLive, lang))}
              </span>
              <button
                onClick={handleRerun}
                className="ml-auto flex-shrink-0 text-[9px] font-bold px-2.5 py-1 transition-opacity hover:opacity-70"
                style={{ background: "#111110", color: "#F0EDE6" }}
              >
                {t.reRecommend}
              </button>
            </div>
          )}
          {isTyping && (
            <div
              className="mt-3 px-3 py-2.5 flex items-center gap-2 text-[10px]"
              style={{ background: "#C8A84B0A", borderLeft: "2px solid #C8A84B" }}
            >
              <Sparkles size={10} style={{ color: "#C8A84B" }} />
              <span className="animate-pulse" style={{ color: "rgba(17,17,16,0.45)" }}>
                {t.searching}
              </span>
            </div>
          )}
        </div>

        {/* Map + Detail */}
        <div className="flex-1 flex overflow-hidden">

          {/* Floor Map */}
          <div className="flex-1 p-6 overflow-auto" style={{ scrollbarWidth: "none" }}>
            {seatsLoading && (
              <div className="text-[11px] text-center mt-20" style={{ color: "rgba(17,17,16,0.4)" }}>
                {t.loadingSeats}
              </div>
            )}
            {seatsError && !seatsLoading && (
              <div className="flex flex-col items-center gap-3 mt-20">
                <div className="flex items-center gap-2 text-[11px]" style={{ color: "#B94040" }}>
                  <AlertTriangle size={12} />
                  {seatsError}
                </div>
                <button
                  onClick={loadSeats}
                  className="text-[9px] font-bold px-3 py-1.5 tracking-widest"
                  style={{ background: "#111110", color: "#F0EDE6" }}
                >
                  {t.retry}
                </button>
              </div>
            )}
            {!seatsLoading && !seatsError && (
              <>
                <svg
                  ref={mapSvgRef}
                  viewBox="0 0 760 510"
                  className="w-full"
                  style={{ maxWidth: 900, minWidth: 520, display: "block", margin: "0 auto", cursor: placingPin ? "crosshair" : "default" }}
                  onClick={handleMapClick}
                >
                  {/* Zone outlines, derived from the real seats on this floor */}
                  {zoneOverlays.map(({ zoneType, bounds }) => {
                    const zoneLabel = ZONE_LABEL[lang][zoneType].toUpperCase();
                    const zoneFontSize = fitFontSize(zoneLabel, bounds.width - 12, 8, 5);
                    return (
                      <g key={zoneType}>
                        <text x={bounds.x + 6} y={bounds.y + 14} fontSize={zoneFontSize} fontFamily="'JetBrains Mono', monospace"
                          fill="currentColor" fillOpacity="0.35" letterSpacing={zoneFontSize / 8 * 2.5}>
                          {zoneLabel}
                        </text>
                        <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} fill="transparent"
                          stroke="currentColor" strokeWidth="0.75" strokeOpacity="0.14" />
                      </g>
                    );
                  })}

                  {/* Seats, positioned at their real bounding boxes */}
                  {floorSeats.map(seat => {
                    const color      = seatDisplayColor(seat);
                    const isSelected = seat.id === selectedId;
                    const isAISugg   = resultSeatIds.has(seat.id);
                    const dimmed     = promptResult !== null && !isAISugg;
                    const [x, y, w, h] = seat.bbox;
                    const { text: label, fontSize: nameFontSize } = fitLabel(seatName(seat, lang), w, 9, 7);
                    const { text: statusLabel, fontSize: statusFontSize } = fitLabel(seatStatusLabel(seat, lang), w, 6.5, 6);

                    return (
                      <g
                        key={seat.id}
                        onClick={() => handleSeatClick(seat)}
                        style={{ cursor: "pointer", opacity: dimmed ? 0.18 : 1, transition: "opacity 0.2s" }}
                      >
                        {isSelected && (
                          <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={8}
                            fill="none" stroke="#C8A84B" strokeWidth="2" />
                        )}
                        {isAISugg && !isSelected && (
                          <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={8}
                            fill="none" stroke="#C8A84B" strokeWidth="1" strokeOpacity="0.7" strokeDasharray="3 2.5" />
                        )}
                        <rect x={x} y={y} width={w} height={h} rx={6}
                          fill={color} fillOpacity={seat.occupancyStatus === "available" ? 0.16 : 0.08}
                          stroke={color} strokeWidth="1.5" />
                        <text
                          x={x + w / 2} y={y + h / 2 - 4}
                          fontSize={nameFontSize} fontFamily="'JetBrains Mono', monospace"
                          fill={color} textAnchor="middle" dominantBaseline="central" fontWeight="700"
                        >
                          {label}
                        </text>
                        <text
                          x={x + w / 2} y={y + h / 2 + 10}
                          fontSize={statusFontSize} fontFamily="'JetBrains Mono', monospace"
                          fill="currentColor" fillOpacity="0.4" textAnchor="middle" dominantBaseline="central"
                        >
                          {statusLabel}
                        </text>
                        {seat.equipment.includes("power_outlet") && (
                          <circle cx={x + w - 9} cy={y + 9} r="3.2" fill="#C8A84B" fillOpacity="0.95" />
                        )}
                        {seat.equipment.includes("projector") && (
                          <circle cx={x + w - 18} cy={y + 9} r="3.2" fill="#5B7FA6" fillOpacity="0.95" />
                        )}
                      </g>
                    );
                  })}

                  {/* Amenities: toilets, exits, elevators, etc. — plain
                      colored markers, no icons, matching the rest of the map. */}
                  {floorAmenities.map(amenity => {
                    const cx = amenity.x + amenity.width / 2;
                    const cy = amenity.y + amenity.height / 2;
                    const abbr = AMENITY_ABBR[amenity.amenityType];
                    const { text: label, fontSize } = fitLabel(abbr, amenity.width, 6.5, 5);
                    return (
                      <g key={amenity.id}>
                        <circle cx={cx} cy={cy} r={amenity.width / 2} fill={PALETTE.amenity} fillOpacity={0.18} stroke={PALETTE.amenity} strokeWidth="1.5" />
                        <text x={cx} y={cy} fontSize={fontSize} fontFamily="'JetBrains Mono', monospace" fontWeight="700"
                          fill={PALETTE.amenity} textAnchor="middle" dominantBaseline="central">
                          {label}
                        </text>
                        {amenity.name && (
                          <title>{amenity.name}</title>
                        )}
                      </g>
                    );
                  })}

                  {/* Self-reported "you are here" pin + straight-line distance
                      to the selected seat and any amenities on this floor. */}
                  {myPin && (
                    <g>
                      {selectedSeat && selectedSeat.floor === floor && (() => {
                        const [sx, sy, sw, sh] = selectedSeat.bbox;
                        const tx = sx + sw / 2, ty = sy + sh / 2;
                        const n = distanceInSeatWidths(myPin.x, myPin.y, tx, ty);
                        return (
                          <g>
                            <line x1={myPin.x} y1={myPin.y} x2={tx} y2={ty} stroke={PALETTE.gold} strokeWidth="1.25" strokeDasharray="4 3" />
                            <text x={(myPin.x + tx) / 2} y={(myPin.y + ty) / 2 - 4} fontSize="7" fontFamily="'JetBrains Mono', monospace"
                              fill={PALETTE.gold} textAnchor="middle" fontWeight="700">
                              {t.seatWidthsAway(n)}
                            </text>
                          </g>
                        );
                      })()}
                      {floorAmenities.map(amenity => {
                        const ax = amenity.x + amenity.width / 2, ay = amenity.y + amenity.height / 2;
                        const n = distanceInSeatWidths(myPin.x, myPin.y, ax, ay);
                        return (
                          <line key={amenity.id} x1={myPin.x} y1={myPin.y} x2={ax} y2={ay}
                            stroke={PALETTE.amenity} strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.5">
                            <title>{`${AMENITY_LABEL[lang][amenity.amenityType]}: ${t.seatWidthsAway(n)}`}</title>
                          </line>
                        );
                      })}
                      <circle cx={myPin.x} cy={myPin.y} r="7" fill={PALETTE.gold} fillOpacity="0.25" stroke={PALETTE.gold} strokeWidth="1.5" />
                      <circle cx={myPin.x} cy={myPin.y} r="2.5" fill={PALETTE.gold} />
                      <text x={myPin.x} y={myPin.y - 11} fontSize="7" fontFamily="'JetBrains Mono', monospace" fontWeight="700"
                        fill={PALETTE.gold} textAnchor="middle">
                        {t.you}
                      </text>
                    </g>
                  )}
                </svg>

                {/* Active filter pills */}
                {activeIntent && (
                  <div className="mt-4 flex flex-wrap items-center gap-2 text-[9px] px-2">
                    <span style={{ color: "rgba(17,17,16,0.4)" }}>{t.matching}</span>
                    <span className="px-2 py-0.5 font-bold" style={{ background: "#111110", color: "#F0EDE6" }}>
                      {ZONE_LABEL[lang][activeIntent.zoneType]}
                    </span>
                    {activeIntent.groupSize > 1 && (
                      <span className="px-2 py-0.5 font-bold" style={{ background: "#111110", color: "#F0EDE6" }}>
                        {t.groupOf(activeIntent.groupSize)}
                      </span>
                    )}
                    {activeIntent.requiredEquipment.map(e => (
                      <span key={e} className="px-2 py-0.5 font-bold" style={{ background: "#111110", color: "#F0EDE6" }}>
                        {EQUIPMENT_LABEL[lang][e]}
                      </span>
                    ))}
                    {proximityDesc(activeIntent, lang) && (
                      <span className="px-2 py-0.5 font-bold" style={{ background: "#111110", color: "#F0EDE6" }}>
                        {proximityDesc(activeIntent, lang)}
                      </span>
                    )}
                    <button
                      onClick={handleClearPrompt}
                      className="text-[9px] underline transition-opacity hover:opacity-60"
                      style={{ color: "rgba(17,17,16,0.4)" }}
                    >
                      {t.clear}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── SEAT INFO POPUP ──────────────────────── */}
          {/* A floating overlay rather than a permanent side panel — the map
              keeps its full width, so it doesn't feel congested once a seat
              is selected. */}
          {selectedSeat && (
            <div
              className="fixed inset-0 z-40 animate-in fade-in-0 duration-150"
              style={{ background: "rgba(17,17,16,0.15)" }}
              onClick={() => setSelectedId(null)}
            />
          )}
          {selectedSeat && (
            <div
              className="fixed top-0 right-0 h-full w-72 flex-shrink-0 flex flex-col border-l border-border overflow-y-auto z-50 animate-in fade-in-0 slide-in-from-right-4 duration-200"
              style={{ background: "#FAFAF8", scrollbarWidth: "none", boxShadow: "-8px 0 24px rgba(17,17,16,0.08)" }}
            >
              <div className="flex items-start justify-between px-5 py-4 border-b border-border">
                <div>
                  <div className="text-[8px] tracking-[0.22em] mb-1" style={{ color: "rgba(17,17,16,0.35)" }}>
                    {t.seatInfo}
                  </div>
                  <div className="text-2xl font-bold leading-none">{seatName(selectedSeat, lang)}</div>
                  <div className="text-[10px] mt-1" style={{ color: "rgba(17,17,16,0.5)" }}>
                    {ZONE_LABEL[lang][selectedSeat.zoneType]}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedId(null)}
                  className="mt-0.5 transition-opacity hover:opacity-50"
                  style={{ color: "rgba(17,17,16,0.4)" }}
                >
                  <X size={13} />
                </button>
              </div>

              {/* Status */}
              <div className="px-5 py-3 border-b border-border">
                <div
                  className="inline-flex items-center gap-1.5 text-[9px] font-bold px-2 py-1"
                  style={{
                    background: `${seatDisplayColor(selectedSeat)}18`,
                    color: seatDisplayColor(selectedSeat),
                  }}
                >
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ background: seatDisplayColor(selectedSeat) }}
                  />
                  {seatStatusLabel(selectedSeat, lang).toUpperCase()}
                </div>
              </div>

              {/* Equipment */}
              <div className="px-5 py-4 border-b border-border">
                <div className="text-[8px] tracking-[0.22em] mb-3" style={{ color: "rgba(17,17,16,0.35)" }}>{t.equipment}</div>
                {selectedSeat.equipment.length > 0 ? (
                  <div className="flex flex-col gap-2.5">
                    {selectedSeat.equipment.map(e => {
                      const Icon = EQUIPMENT_ICON[e];
                      return (
                        <div key={e} className="flex items-center gap-2.5 text-[10px]">
                          <Icon size={10} className="text-muted-foreground flex-shrink-0" />
                          {EQUIPMENT_LABEL[lang][e]}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-[10px] text-muted-foreground">{t.noEquipment}</div>
                )}
              </div>

              {/* Location */}
              <div className="px-5 py-4 border-b border-border">
                <div className="text-[8px] tracking-[0.22em] mb-3" style={{ color: "rgba(17,17,16,0.35)" }}>{t.location}</div>
                <div className="flex flex-col gap-1.5 text-[10px]">
                  <div className="flex justify-between">
                    <span style={{ color: "rgba(17,17,16,0.45)" }}>{t.floorLabel}</span>
                    <span className="font-bold">{selectedSeat.floor}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: "rgba(17,17,16,0.45)" }}>{t.capacity}</span>
                    <span className="font-bold">
                      {selectedSeat.capacity > 1 && selectedSeat.availableSeats != null
                        ? t.freeOfTotal(selectedSeat.availableSeats, selectedSeat.capacity)
                        : selectedSeat.capacity}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span style={{ color: "rgba(17,17,16,0.45)" }}>{t.where}</span>
                    <span className="font-bold text-right">{seatLocation(selectedSeat, lang)}</span>
                  </div>
                </div>
              </div>

              {/* Self check-in (beta) */}
              <div className="px-5 py-4 border-b border-border">
                <div className="flex items-center gap-1.5 mb-3">
                  <div className="text-[8px] tracking-[0.22em]" style={{ color: "rgba(17,17,16,0.35)" }}>{t.checkInTitle}</div>
                  <span className="flex items-center gap-0.5 px-1.5 py-0.5 text-[7px] font-bold" style={{ background: "#C8A84B22", color: "#8a6f2e" }}>
                    <FlaskConical size={8} /> {t.betaLabel}
                  </span>
                </div>

                {myCheckIn && myCheckIn.tableId !== selectedSeat.id ? (
                  <div className="text-[10px] leading-relaxed" style={{ color: "rgba(17,17,16,0.5)" }}>
                    {t.checkedInBanner(myCheckIn.seatName)}
                  </div>
                ) : checkInForm?.tableId === selectedSeat.id ? (
                  <div className="flex flex-col gap-2.5">
                    {checkInError && <ErrorBanner message={checkInError} />}
                    {checkInForm.chairs.length === 0 ? (
                      <div className="text-[10px]" style={{ color: "rgba(17,17,16,0.4)" }}>{t.noAvailableChairs}</div>
                    ) : (
                      <>
                        {checkInForm.chairs.length > 1 && (
                          <div>
                            <div className="text-[8px] mb-1.5" style={{ color: "rgba(17,17,16,0.4)" }}>{t.pickYourChair}</div>
                            <div className="flex flex-wrap gap-1">
                              {checkInForm.chairs.map(c => (
                                <button
                                  key={c.id}
                                  onClick={() => setCheckInChairId(c.id)}
                                  className="px-2 py-1 text-[9px] font-bold"
                                  style={{
                                    background: checkInChairId === c.id ? "#111110" : "rgba(17,17,16,0.06)",
                                    color: checkInChairId === c.id ? "#F0EDE6" : "rgba(17,17,16,0.6)",
                                  }}
                                >
                                  {c.id.slice(c.id.lastIndexOf("-") + 1)}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        <div>
                          <div className="text-[8px] mb-1.5" style={{ color: "rgba(17,17,16,0.4)" }}>{t.checkInDuration}</div>
                          <div className="flex gap-1">
                            {([60, 120] as const).map(d => (
                              <button
                                key={d}
                                onClick={() => setCheckInDuration(d)}
                                className="flex-1 px-2 py-1.5 text-[9px] font-bold"
                                style={{
                                  background: checkInDuration === d ? "#111110" : "rgba(17,17,16,0.06)",
                                  color: checkInDuration === d ? "#F0EDE6" : "rgba(17,17,16,0.6)",
                                }}
                              >
                                {d === 60 ? t.oneHour : t.twoHours}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="text-[8px] mb-1.5" style={{ color: "rgba(17,17,16,0.4)" }}>{t.nicknameLabel}</div>
                          <input
                            value={nickname}
                            onChange={e => persistNickname(e.target.value.slice(0, 24))}
                            placeholder={t.nicknamePlaceholder}
                            className="w-full px-2 py-1.5 border border-border bg-background outline-none text-[10px]"
                          />
                        </div>
                        <div className="flex gap-2 mt-1">
                          <button
                            disabled={checkInBusy || !checkInChairId}
                            onClick={submitCheckIn}
                            className="flex-1 px-2.5 py-1.5 text-[9px] font-bold disabled:opacity-40"
                            style={{ background: PALETTE.available, color: "#fff" }}
                          >
                            {checkInBusy ? "…" : t.confirmCheckIn}
                          </button>
                          <button
                            onClick={() => setCheckInForm(null)}
                            className="px-2.5 py-1.5 text-[9px] font-bold"
                            style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.6)" }}
                          >
                            {t.cancelCheckIn}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="text-[10px] leading-relaxed mb-3" style={{ color: "rgba(17,17,16,0.5)" }}>
                      {t.checkInDesc}
                    </div>
                    <button
                      disabled={!!myCheckIn || (selectedSeat.availableSeats ?? (selectedSeat.occupancyStatus === "available" ? selectedSeat.capacity : 0)) <= 0}
                      onClick={() => openCheckInForm(selectedSeat.id, seatName(selectedSeat, lang))}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 text-[9px] font-bold w-full justify-center disabled:opacity-30"
                      style={{ background: "#111110", color: "#F0EDE6" }}
                    >
                      <LogIn size={11} /> {t.checkInHere}
                    </button>
                  </>
                )}
              </div>

              {/* Prompt nudge */}
              <div className="px-5 py-4 mt-auto">
                <div className="text-[8px] tracking-[0.22em] mb-2" style={{ color: "rgba(17,17,16,0.3)" }}>
                  {t.lookingForSomethingElse}
                </div>
                <button
                  onClick={() => { setSelectedId(null); inputRef.current?.focus(); }}
                  className="flex items-center gap-2 text-[9px] transition-opacity hover:opacity-60"
                  style={{ color: "rgba(17,17,16,0.5)" }}
                >
                  <CornerDownLeft size={9} />
                  {t.describeAgain}
                </button>
              </div>
            </div>
          )}

          {/* ── LEADERBOARD MODAL ────────────────────── */}
          {showLeaderboard && (
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center p-6"
              style={{ background: "rgba(17,17,16,0.4)" }}
              onClick={() => setShowLeaderboard(false)}
            >
              <div
                className="w-full max-w-xs border border-border animate-in fade-in-0 zoom-in-95 duration-150"
                style={{ background: "#FAFAF8", fontFamily: "'JetBrains Mono', monospace" }}
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-start justify-between px-5 py-4 border-b border-border">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <Trophy size={13} style={{ color: "#C8A84B" }} />
                      <span className="text-xs font-bold tracking-widest">{t.leaderboardTitle}</span>
                    </div>
                    <div className="text-[9px] mt-1.5 leading-relaxed" style={{ color: "rgba(17,17,16,0.5)" }}>
                      {t.leaderboardDesc}
                    </div>
                  </div>
                  <button onClick={() => setShowLeaderboard(false)} style={{ color: "rgba(17,17,16,0.4)" }}>
                    <X size={13} />
                  </button>
                </div>
                <div className="px-5 py-4">
                  {nickname && myPoints != null && (
                    <div className="flex items-center justify-between mb-3 pb-3 border-b border-border text-[10px]">
                      <span style={{ color: "rgba(17,17,16,0.5)" }}>{t.yourPoints} ({nickname})</span>
                      <span className="font-bold" style={{ color: "#C8A84B" }}>{t.pointsTotal(myPoints)}</span>
                    </div>
                  )}
                  {leaderboard.length === 0 ? (
                    <div className="text-[10px]" style={{ color: "rgba(17,17,16,0.35)" }}>{t.leaderboardEmpty}</div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {leaderboard.map((entry, i) => (
                        <div key={entry.nickname} className="flex items-center justify-between text-[10px]">
                          <span style={{ color: "rgba(17,17,16,0.6)" }}>
                            <span className="inline-block w-4" style={{ color: "rgba(17,17,16,0.3)" }}>{i + 1}.</span> {entry.nickname}
                          </span>
                          <span className="font-bold">{t.pointsTotal(entry.points)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
