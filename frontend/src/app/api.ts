export type ZoneType = "quiet" | "collaborative";
export type OccupancyStatus = "available" | "occupied";
export type Equipment = "power_outlet" | "projector";
export type MatchType = "perfect" | "alternative" | "none";
export type LayoutObjectType = "table" | "seat" | "amenity";
export type AmenityType = "toilet" | "exit" | "elevator" | "stairs" | "water_fountain" | "printer" | "entrance" | "help_desk" | "other";

export interface Seat {
  id: string;
  name_en: string;
  name_zh: string;
  zoneType: ZoneType;
  capacity: number;
  availableSeats?: number;
  equipment: Equipment[];
  floor: number;
  location_en: string;
  location_zh: string;
  occupancyStatus: OccupancyStatus;
  bbox: [number, number, number, number];
}

export interface Intent {
  zoneType: ZoneType;
  groupSize: number;
  requiredEquipment: Equipment[];
  accessibilityNeeds: string | null;
  floor: number | null;
  nearAmenity?: AmenityType | null;
  farAmenity?: AmenityType | null;
}

export interface RecommendResponse {
  intent: Intent;
  seat: Seat | null;
  seats: Seat[];
  matchType: MatchType;
}

export interface LogEntry {
  id: string;
  action: string;
  detail: string;
  floor: number | null;
  timestamp: string;
}

export interface FloorStats {
  total: number;
  available: number;
  occupied: number;
}

export interface DashboardResponse {
  stats: {
    total: number;
    available: number;
    occupied: number;
    by_floor: Record<string, FloorStats>;
  };
}

export interface FloorMeta {
  number: number;
  label: string;
}

export interface LayoutObject {
  id: string;
  type: LayoutObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  location: string;
  rotation: number;
  zoneType: ZoneType | "";
  capacity: number;
  equipment: Equipment[];
  floor: number;
  color: string;
  tableId?: string | null;
  occupancyStatus?: OccupancyStatus | null;
  amenityType?: AmenityType | null;
}

export interface Layout {
  objects: LayoutObject[];
  floors: FloorMeta[];
  canvasWidth: number;
  canvasHeight: number;
}

export interface Amenity {
  id: string;
  name: string;
  amenityType: AmenityType;
  floor: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Camera calibration ────────────────────────────────────────────────
// Boxes are normalized 0–1 fractions of the camera image (not floor-plan
// canvas pixels). See docs/camera_calibration.md.

export interface SeatBox {
  seatId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Camera {
  id: string;
  floor: number;
  label: string;
  image: string;
  imageWidth: number | null;
  imageHeight: number | null;
  calibratedAt: string | null;
  seatBoxes: SeatBox[];
}

export interface DetectResult {
  status: string;
  results: Record<string, OccupancyStatus>;
  personCount: number;
  updated: number;
}

export interface AnalyticsData {
  peakHours: { hour: number; count: number }[];
  popularSeats: { seatId: string; count: number }[];
  facilityUsage: { equipment: string; total: number; occupied: number }[];
  unmetDemand: { seatId: string; occupiedCount: number }[];
  turnover: { date: string; count: number }[];
  dailyCheckins: { date: string; count: number }[];
  zoneStats: Record<string, { total: number; occupied: number }>;
  floorStats: Record<string, { total: number; occupied: number }>;
  totalCheckins: number;
  totalCheckouts: number;
  uniqueSeatsUsed: number;
}

// ── Self check-in ───────────────────────────────────────────────────
// A camera-free, no-login alternative for reporting occupancy: a student
// picks their own chair and self-reports "I'm sitting here." A nickname is
// entirely optional and never verified — it's a courtesy tag for a personal
// point counter, not an identity check.

export interface Chair {
  id: string;
  tableId: string | null;
  floor: number;
  occupancyStatus: OccupancyStatus | null;
}

export interface CheckInResult {
  checkinId: string;
  seatId: string;
  expiresAt: string;
  durationMinutes: number;
  points: number | null;
}

export const SERVER_BASE = "http://localhost:8000";
const API_BASE = `${SERVER_BASE}/api`;

const TOKEN_KEY = "findaspot_admin_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export const UNAUTHORIZED_EVENT = "findaspot-unauthorized";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.detail ?? "";
    } catch {
      // ignore
    }
    if (res.status === 401) {
      clearToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return res.json();
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Finder ──────────────────────────────────────────────────────────

export async function fetchSeats(): Promise<Seat[]> {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await handle<{ seats: Seat[] }>(res);
  return data.seats;
}

export async function fetchFloors(): Promise<FloorMeta[]> {
  const res = await fetch(`${API_BASE}/floors`);
  const data = await handle<{ floors: FloorMeta[] }>(res);
  return data.floors;
}

export async function fetchAmenities(): Promise<Amenity[]> {
  const res = await fetch(`${API_BASE}/amenities`);
  const data = await handle<{ amenities: Amenity[] }>(res);
  return data.amenities;
}

export async function recommendSeat(query: string, lang: "en" | "zh" = "en", floor?: number | null): Promise<RecommendResponse> {
  const res = await fetch(`${API_BASE}/recommend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, lang, floor: floor ?? null }),
  });
  return handle<RecommendResponse>(res);
}

export async function fetchChairs(tableId?: string): Promise<Chair[]> {
  const url = tableId ? `${API_BASE}/chairs?tableId=${encodeURIComponent(tableId)}` : `${API_BASE}/chairs`;
  const res = await fetch(url);
  const data = await handle<{ chairs: Chair[] }>(res);
  return data.chairs;
}

export async function checkIn(seatId: string, durationMinutes: 60 | 120, nickname?: string | null): Promise<CheckInResult> {
  const res = await fetch(`${API_BASE}/checkin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seatId, durationMinutes, nickname: nickname || null }),
  });
  return handle<CheckInResult>(res);
}

export async function confirmCheckIn(checkinId: string): Promise<{ expiresAt: string; points: number | null }> {
  const res = await fetch(`${API_BASE}/checkin/${encodeURIComponent(checkinId)}/confirm`, { method: "POST" });
  return handle(res);
}

export async function checkOut(checkinId: string): Promise<{ status: string; points: number | null }> {
  const res = await fetch(`${API_BASE}/checkin/${encodeURIComponent(checkinId)}/checkout`, { method: "POST" });
  return handle(res);
}

export async function fetchPoints(nickname: string): Promise<number> {
  const res = await fetch(`${API_BASE}/points/${encodeURIComponent(nickname)}`);
  const data = await handle<{ points: number }>(res);
  return data.points;
}

export async function fetchLeaderboard(limit = 10): Promise<{ nickname: string; points: number }[]> {
  const res = await fetch(`${API_BASE}/leaderboard?limit=${limit}`);
  const data = await handle<{ leaderboard: { nickname: string; points: number }[] }>(res);
  return data.leaderboard;
}

// ── Admin: auth ───────────────────────────────────────────────────────
// No signup — the shared admin credential is provisioned via
// scripts/create_admin.py (shell access required), not over HTTP.

export async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await handle<{ token: string; username: string }>(res);
  setToken(data.token);
  return data.username;
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/admin/auth/logout`, { method: "POST", headers: authHeaders() });
  } finally {
    clearToken();
  }
}

export async function whoAmI(): Promise<string> {
  const res = await fetch(`${API_BASE}/admin/auth/me`, { headers: authHeaders() });
  const data = await handle<{ username: string }>(res);
  return data.username;
}

// ── Admin: admin accounts ─────────────────────────────────────────────
// Flat model, no roles — any logged-in admin can add/remove another.
// There's no public signup; the first account comes from
// scripts/create_admin.py.

export async function fetchAdmins(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/admin/users`, { headers: authHeaders() });
  const data = await handle<{ users: string[] }>(res);
  return data.users;
}

export async function addAdmin(username: string, password: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ username, password }),
  });
  await handle(res);
}

export async function deleteAdmin(username: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(username)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  await handle(res);
}

// ── Admin: dashboard ──────────────────────────────────────────────────

export async function fetchDashboard(): Promise<DashboardResponse> {
  const res = await fetch(`${API_BASE}/admin/dashboard`, { headers: authHeaders() });
  return handle<DashboardResponse>(res);
}

// ── Admin: seats ──────────────────────────────────────────────────────

export async function fetchAdminSeats(floor?: number): Promise<Seat[]> {
  const url = floor != null ? `${API_BASE}/admin/seats?floor=${floor}` : `${API_BASE}/admin/seats`;
  const res = await fetch(url, { headers: authHeaders() });
  const data = await handle<{ seats: Seat[] }>(res);
  return data.seats;
}

export async function updateSeatStatus(seatId: string, status: OccupancyStatus): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/seats/${seatId}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ status }),
  });
  await handle(res);
}

// ── Admin: logs ─────────────────────────────────────────────────────

export async function fetchLogs(limit = 50): Promise<LogEntry[]> {
  const res = await fetch(`${API_BASE}/admin/logs?limit=${limit}`, { headers: authHeaders() });
  const data = await handle<{ logs: LogEntry[] }>(res);
  return data.logs;
}

export async function fetchAnalytics(): Promise<AnalyticsData> {
  const res = await fetch(`${API_BASE}/admin/analytics`, { headers: authHeaders() });
  return handle<AnalyticsData>(res);
}

// ── Admin: floor-plan editor ─────────────────────────────────────────

export async function fetchLayout(): Promise<Layout> {
  const res = await fetch(`${API_BASE}/admin/layout`, { headers: authHeaders() });
  return handle<Layout>(res);
}

export async function saveLayout(objects: LayoutObject[], floors: FloorMeta[], canvasWidth: number, canvasHeight: number): Promise<{ status: string; seats_count: number }> {
  const res = await fetch(`${API_BASE}/admin/layout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ objects, floors, canvasWidth, canvasHeight }),
  });
  return handle(res);
}

// ── Admin: camera calibration ─────────────────────────────────────────

export async function fetchCameras(floor?: number): Promise<Camera[]> {
  const url = floor != null ? `${API_BASE}/admin/cameras?floor=${floor}` : `${API_BASE}/admin/cameras`;
  const res = await fetch(url, { headers: authHeaders() });
  const data = await handle<{ cameras: Camera[] }>(res);
  return data.cameras;
}

export async function createCamera(file: File, floor: number, label: string): Promise<Camera> {
  const form = new FormData();
  form.append("file", file);
  form.append("floor", String(floor));
  form.append("label", label);
  const res = await fetch(`${API_BASE}/admin/cameras`, {
    method: "POST",
    headers: authHeaders(), // don't set Content-Type — the browser adds the multipart boundary
    body: form,
  });
  return handle<Camera>(res);
}

export async function deleteCamera(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/cameras/${id}`, { method: "DELETE", headers: authHeaders() });
  await handle(res);
}

/** Swap in a fresh frame (e.g. a new webcam capture) without touching
 * calibration — lets a live test loop re-run detection against what the
 * camera sees right now instead of a one-time upload. */
export async function replaceCameraSnapshot(id: string, file: File): Promise<Camera> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/admin/cameras/${id}/snapshot`, {
    method: "PUT",
    headers: authHeaders(),
    body: form,
  });
  return handle<Camera>(res);
}

export async function saveCalibration(id: string, seatBoxes: SeatBox[]): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/cameras/${id}/calibration`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ seatBoxes }),
  });
  await handle(res);
}

export async function runDetection(id: string): Promise<DetectResult> {
  // No personBoxes → the backend runs YOLO on the stored snapshot.
  const res = await fetch(`${API_BASE}/admin/cameras/${id}/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  return handle<DetectResult>(res);
}

/** Fetch the snapshot with auth and return an object URL. Caller must
 * URL.revokeObjectURL() it when done. (A plain <img src> can't send the
 * bearer token, and the endpoint is admin-gated.) */
export async function fetchCameraSnapshotUrl(id: string): Promise<string> {
  const res = await fetch(`${API_BASE}/admin/cameras/${id}/snapshot`, { headers: authHeaders() });
  if (!res.ok) {
    if (res.status === 401) {
      clearToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new Error(`Couldn't load snapshot (${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
