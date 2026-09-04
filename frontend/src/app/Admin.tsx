import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router";
import {
  ArrowLeft, LayoutDashboard, Armchair, Map as MapIcon, History, Users,
  LogOut, Lock, Plus, Trash2, Languages, HelpCircle, BarChart3,
} from "lucide-react";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import {
  fetchDashboard, updateSeatStatus,
  fetchLogs, fetchLayout, fetchAnalytics,
  fetchAdmins, addAdmin, deleteAdmin,
  getToken, clearToken, login, logout, whoAmI,
  UNAUTHORIZED_EVENT,
  type DashboardResponse, type LogEntry, type Layout, type LayoutObject,
  type AnalyticsData,
} from "./api";
import SetupFlow from "./SetupFlow";
import { ErrorBanner, SectionTitle } from "./ui";
import { type Lang, UI, useLang } from "./i18n";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

const ONBOARDED_KEY_PREFIX = "findaspot_onboarded_";

type Tab = "dashboard" | "seats" | "setup" | "admins" | "logs" | "analytics";

export default function Admin() {
  const [username, setUsername] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [lang, toggleLang] = useLang();

  useEffect(() => {
    if (!getToken()) {
      setCheckingSession(false);
      return;
    }
    whoAmI()
      .then(setUsername)
      .catch(() => clearToken())
      .finally(() => setCheckingSession(false));
  }, []);

  // Bounce back to the login screen if any admin request comes back 401
  // (e.g. the in-memory session was lost to a backend restart).
  useEffect(() => {
    const onUnauthorized = () => setUsername(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (checkingSession) {
    return (
      <div className="size-full flex items-center justify-center text-[11px]" style={{ color: "rgba(17,17,16,0.4)", fontFamily: "'JetBrains Mono', monospace" }}>
        Loading…
      </div>
    );
  }

  if (!username) {
    return <AuthGate onAuthed={setUsername} lang={lang} toggleLang={toggleLang} />;
  }

  return <AdminShell username={username} onLoggedOut={() => setUsername(null)} lang={lang} toggleLang={toggleLang} />;
}

// ── Auth gate: login only — no public signup, see scripts/create_admin.py ──

function AuthGate({ onAuthed, lang, toggleLang }: { onAuthed: (username: string) => void; lang: Lang; toggleLang: () => void }) {
  const t = UI[lang];
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    if (!form.username.trim() || !form.password) return;
    setBusy(true);
    setError(null);
    try {
      const name = await login(form.username.trim(), form.password);
      onAuthed(name);
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="size-full flex items-center justify-center bg-background text-foreground relative"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      <button
        onClick={toggleLang}
        className="absolute top-4 right-4 flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold border border-border transition-colors hover:border-[#C8A84B]"
        style={{ color: "rgba(17,17,16,0.6)" }}
      >
        <Languages size={11} /> {t.langToggleLabel}
      </button>

      <div className="w-full max-w-xs">
        <div className="flex items-center gap-2 mb-1">
          <Lock size={13} style={{ color: "#C8A84B" }} />
          <span className="text-xs font-bold tracking-widest">{t.adminBrand}</span>
        </div>
        <div className="text-[10px] mb-6" style={{ color: "rgba(17,17,16,0.45)" }}>
          {t.loginPrompt}
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="flex flex-col gap-2 mb-4">
          <input
            value={form.username}
            onChange={e => setForm({ ...form, username: e.target.value })}
            placeholder={t.username}
            autoFocus
            className="px-3 py-2 border border-border bg-background outline-none text-[11px]"
          />
          <input
            value={form.password}
            onChange={e => setForm({ ...form, password: e.target.value })}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
            type="password"
            placeholder={t.password}
            className="px-3 py-2 border border-border bg-background outline-none text-[11px]"
          />
        </div>

        <button
          disabled={busy || !form.username.trim() || !form.password}
          onClick={handleSubmit}
          className="w-full py-2.5 text-[10px] font-bold tracking-widest disabled:opacity-40"
          style={{ background: "#111110", color: "#F0EDE6" }}
        >
          {busy ? "…" : t.logIn}
        </button>

        <Link to="/" className="mt-6 flex items-center justify-center gap-1.5 text-[9px] transition-opacity hover:opacity-60" style={{ color: "rgba(17,17,16,0.35)" }}>
          <ArrowLeft size={10} /> {t.backToHome}
        </Link>
      </div>
    </div>
  );
}

// ── Authenticated shell ───────────────────────────────────────────────

function AdminShell({ username, onLoggedOut, lang, toggleLang }: { username: string; onLoggedOut: () => void; lang: Lang; toggleLang: () => void }) {
  const t = UI[lang];
  const [tab, setTab] = useState<Tab>("dashboard");

  const TABS: { id: Tab; label: string; Icon: typeof LayoutDashboard }[] = [
    { id: "dashboard", label: t.tabDashboard, Icon: LayoutDashboard },
    { id: "seats",     label: t.tabSeats,     Icon: Armchair },
    { id: "setup",     label: t.tabSetup,     Icon: MapIcon },
    { id: "admins",    label: t.tabAdmins,    Icon: Users },
    { id: "logs",      label: t.tabActivity,  Icon: History },
    { id: "analytics", label: t.tabAnalytics, Icon: BarChart3 },
  ];

  const handleLogout = async () => {
    await logout();
    onLoggedOut();
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
        localStorage.setItem(ONBOARDED_KEY_PREFIX + username, "1");
        tourDriver.destroy();
      },
      steps: [
        { popover: { title: t.tourWelcomeTitle, description: t.tourWelcomeDesc } },
        { element: "#tour-tab-dashboard", onHighlightStarted: () => setTab("dashboard"), popover: { title: t.tourDashboardTitle, description: t.tourDashboardDesc, side: "bottom" } },
        { element: "#tour-tab-seats", onHighlightStarted: () => setTab("seats"), popover: { title: t.tourSeatsTitle, description: t.tourSeatsDesc, side: "bottom" } },
        { element: "#tour-tab-setup", onHighlightStarted: () => setTab("setup"), popover: { title: t.tourSetupTitle, description: t.tourSetupDesc, side: "bottom" } },
        { element: "#tour-tab-admins", onHighlightStarted: () => setTab("admins"), popover: { title: t.tourAdminsTitle, description: t.tourAdminsDesc, side: "bottom" } },
        { element: "#tour-tab-logs", onHighlightStarted: () => setTab("logs"), popover: { title: t.tourLogsTitle, description: t.tourLogsDesc, side: "bottom" } },
        { element: "#tour-tab-analytics", onHighlightStarted: () => setTab("analytics"), popover: { title: t.tourAnalyticsTitle, description: t.tourAnalyticsDesc, side: "bottom" } },
        { element: "#tour-lang-toggle", popover: { title: t.tourLangTitle, description: t.tourLangDesc, side: "bottom" } },
      ],
    });
    tourDriver.drive();
  }, [t, username]);

  // Guided tour runs once per admin account (tracked in localStorage, keyed
  // by username) the first time they land on the dashboard.
  useEffect(() => {
    if (!localStorage.getItem(ONBOARDED_KEY_PREFIX + username)) {
      const id = setTimeout(startTour, 500);
      return () => clearTimeout(id);
    }
  }, []);

  return (
    <div
      className="size-full flex flex-col bg-background text-foreground overflow-hidden"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border" style={{ background: "#111110", color: "#F0EDE6" }}>
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-1.5 text-[10px] transition-opacity hover:opacity-60" style={{ color: "rgba(240,237,230,0.6)" }}>
            <ArrowLeft size={12} /> {t.backToHome}
          </Link>
          <span className="text-[10px]" style={{ color: "rgba(240,237,230,0.2)" }}>|</span>
          <span className="text-xs font-bold tracking-widest">{t.adminBrand}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                id={`tour-tab-${id}`}
                onClick={() => setTab(id)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold tracking-wide transition-colors"
                style={{
                  background: tab === id ? "#F0EDE6" : "rgba(240,237,230,0.07)",
                  color: tab === id ? "#111110" : "rgba(240,237,230,0.5)",
                }}
              >
                <Icon size={11} /> {label.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={startTour}
            title={t.tourReplay}
            className="flex items-center gap-1 px-2 py-1.5 text-[9px] font-bold transition-opacity hover:opacity-60"
            style={{ color: "rgba(240,237,230,0.6)" }}
          >
            <HelpCircle size={11} />
          </button>
          <Link
            to="/faq?role=admin"
            title={t.faqTitle}
            className="flex items-center gap-1 px-2 py-1.5 text-[9px] font-bold transition-opacity hover:opacity-60"
            style={{ color: "rgba(240,237,230,0.6)" }}
          >
            {t.faqTitle}
          </Link>
          <button
            id="tour-lang-toggle"
            onClick={toggleLang}
            className="flex items-center gap-1 px-2 py-1.5 text-[9px] font-bold transition-opacity hover:opacity-60"
            style={{ color: "rgba(240,237,230,0.6)" }}
          >
            <Languages size={11} /> {t.langToggleLabel}
          </button>
          <span className="text-[9px]" style={{ color: "rgba(240,237,230,0.35)" }}>{username}</span>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1 text-[9px] transition-opacity hover:opacity-60"
            style={{ color: "rgba(240,237,230,0.5)" }}
          >
            <LogOut size={11} /> {t.logOut}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6" style={{ background: "#FAFAF8" }}>
        {tab === "dashboard" && <DashboardTab lang={lang} />}
        {tab === "seats" && <SeatsTab lang={lang} />}
        {tab === "setup" && <SetupFlow lang={lang} />}
        {tab === "admins" && <AdminsTab currentUsername={username} />}
        {tab === "logs" && <LogsTab />}
        {tab === "analytics" && <AnalyticsTab lang={lang} />}
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────

function DashboardTab({ lang }: { lang: Lang }) {
  const t = UI[lang];
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDashboard().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <div className="text-[11px]" style={{ color: "rgba(17,17,16,0.4)" }}>{t.loadingSeats}</div>;

  const floors = Object.keys(data.stats.by_floor).sort();

  return (
    <div>
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { label: t.totalSeats, value: data.stats.total, color: "#111110" },
          { label: t.available.toUpperCase(),   value: data.stats.available, color: "#3D8B5E" },
          { label: t.occupied.toUpperCase(),    value: data.stats.occupied, color: "#B94040" },
        ].map(({ label, value, color }) => (
          <div key={label} className="border border-border px-4 py-4" style={{ background: "#FFFFFF" }}>
            <div className="text-[8px] tracking-[0.18em] mb-2" style={{ color: "rgba(17,17,16,0.4)" }}>{label}</div>
            <div className="text-2xl font-bold" style={{ color }}>{value}</div>
          </div>
        ))}
      </div>

      <SectionTitle>{t.perFloorBreakdown}</SectionTitle>
      <div className="flex flex-col gap-2">
        {floors.map(f => {
          const s = data.stats.by_floor[f];
          const pct = s.total > 0 ? Math.round((s.available / s.total) * 100) : 0;
          return (
            <div key={f} className="flex items-center gap-4 border border-border px-4 py-3" style={{ background: "#FFFFFF" }}>
              <span className="text-xs font-bold w-16">{t.floorLabel} {f}</span>
              <div className="flex-1 h-1.5" style={{ background: "rgba(17,17,16,0.08)" }}>
                <div className="h-full" style={{ width: `${pct}%`, background: "#3D8B5E" }} />
              </div>
              <span className="text-[10px] w-40 text-right" style={{ color: "rgba(17,17,16,0.5)" }}>
                {s.available} {t.available.toLowerCase()} · {s.occupied} {t.occupied.toLowerCase()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Seats ─────────────────────────────────────────────────────────────
// Occupancy here is a plain available/occupied flag standing in for what a
// computer-vision system would report — no individual identity is tracked.

function SeatsTab({ lang }: { lang: Lang }) {
  const t = UI[lang];
  const [layout, setLayout] = useState<Layout | null>(null);
  const [floor, setFloor] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchLayout()
      .then(l => { setLayout(l); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (seatObj: LayoutObject) => {
    setBusyId(seatObj.id);
    try {
      await updateSeatStatus(seatObj.id, seatObj.occupancyStatus === "available" ? "occupied" : "available");
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const objects = layout?.objects ?? [];
  const tables = objects.filter(o => o.type === "table" && (floor == null || o.floor === floor));
  const seatsByTable = new Map<string, LayoutObject[]>();
  for (const o of objects) {
    if (o.type === "seat" && o.tableId) {
      if (!seatsByTable.has(o.tableId)) seatsByTable.set(o.tableId, []);
      seatsByTable.get(o.tableId)!.push(o);
    }
  }

  if (loading) {
    return <div className="text-[10px]" style={{ color: "rgba(17,17,16,0.4)" }}>{t.loadingSeats}</div>;
  }

  if (error && !layout) {
    return (
      <div>
        <ErrorBanner message={error} />
        <button
          onClick={load}
          className="px-3 py-1.5 text-[9px] font-bold"
          style={{ background: "rgba(17,17,16,0.06)", color: "rgba(17,17,16,0.6)" }}
        >
          {t.retry}
        </button>
      </div>
    );
  }

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <div className="mb-2 text-[10px] max-w-xl leading-relaxed" style={{ color: "rgba(17,17,16,0.45)" }}>
        {t.seatsToggleHint}
      </div>
      <SectionTitle>{t.floorHeading}</SectionTitle>
      <div className="flex gap-1 mb-5">
        {[undefined, ...(layout?.floors.map(f => f.number) ?? [])].map(f => (
          <button
            key={f ?? "all"}
            onClick={() => setFloor(f)}
            className="px-3 py-1.5 text-[10px] font-bold"
            style={{ background: floor === f ? "#111110" : "rgba(17,17,16,0.06)", color: floor === f ? "#F0EDE6" : "rgba(17,17,16,0.5)" }}
          >
            {f ? `${t.floorLabel} ${f}` : t.all}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {tables.map(table => {
          const children = seatsByTable.get(table.id) ?? [];
          const availCount = children.filter(c => c.occupancyStatus === "available").length;
          return (
            <div key={table.id} className="border border-border" style={{ background: "#FFFFFF" }}>
              <div className="flex items-center justify-between px-4 py-2 border-b border-border" style={{ background: "rgba(17,17,16,0.03)" }}>
                <span className="text-[10px] font-bold">
                  {table.name || table.id}{" "}
                  <span style={{ color: "rgba(17,17,16,0.4)" }}>· F{table.floor} · {table.zoneType}</span>
                </span>
                <span className="text-[10px] font-bold" style={{ color: availCount > 0 ? "#3D8B5E" : "#B94040" }}>
                  {availCount}/{children.length} {t.available.toLowerCase()}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 p-3">
                {children.length === 0 && (
                  <span className="text-[9px]" style={{ color: "rgba(17,17,16,0.35)" }}>{t.noSeatsOnTable}</span>
                )}
                {children.map(seat => {
                  const isAvailable = seat.occupancyStatus === "available";
                  const label = seat.id.includes("-") ? seat.id.slice(seat.id.lastIndexOf("-") + 1) : seat.id;
                  return (
                    <button
                      key={seat.id}
                      disabled={busyId === seat.id}
                      onClick={() => handleToggle(seat)}
                      title={seat.id}
                      className="px-2.5 py-1.5 text-[9px] font-bold disabled:opacity-30"
                      style={{
                        background: isAvailable ? "#3D8B5E18" : "#B9404018",
                        color: isAvailable ? "#3D8B5E" : "#B94040",
                        border: `1px solid ${isAvailable ? "#3D8B5E" : "#B94040"}`,
                      }}
                    >
                      {label} · {isAvailable ? t.available.toUpperCase() : t.occupied.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {tables.length === 0 && (
          <div className="text-[10px]" style={{ color: "rgba(17,17,16,0.35)" }}>
            {t.noTablesYet}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Admins ────────────────────────────────────────────────────────────
// Flat model, no roles: any logged-in admin can add or remove another.
// There's no public signup — the first account comes from
// scripts/create_admin.py; everyone after that is added here.

function AdminsTab({ currentUsername }: { currentUsername: string }) {
  const [admins, setAdmins] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchAdmins().then(setAdmins).catch(e => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!form.username.trim() || !form.password) return;
    setBusy(true);
    setError(null);
    try {
      await addAdmin(form.username.trim(), form.password);
      setForm({ username: "", password: "" });
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (username: string) => {
    if (!window.confirm(`Remove admin access for "${username}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAdmin(username);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <div className="mb-4 text-[10px] max-w-xl leading-relaxed" style={{ color: "rgba(17,17,16,0.45)" }}>
        Anyone with an account here has full admin access — seats, layout, and this list. There's
        no public signup; only an existing admin can add another.
      </div>

      <SectionTitle>ADD ADMIN</SectionTitle>
      <div className="flex items-center gap-2 mb-6">
        <input
          value={form.username}
          onChange={e => setForm({ ...form, username: e.target.value })}
          placeholder="username"
          className="px-2 py-1.5 border border-border bg-background outline-none text-[10px] w-40"
        />
        <input
          value={form.password}
          onChange={e => setForm({ ...form, password: e.target.value })}
          onKeyDown={e => e.key === "Enter" && handleAdd()}
          type="password"
          placeholder="password (min 6 characters)"
          className="px-2 py-1.5 border border-border bg-background outline-none text-[10px] w-52"
        />
        <button
          disabled={busy || !form.username.trim() || !form.password}
          onClick={handleAdd}
          className="flex items-center gap-1 px-3 py-1.5 text-[9px] font-bold disabled:opacity-30"
          style={{ background: "#111110", color: "#F0EDE6" }}
        >
          <Plus size={10} /> ADD
        </button>
      </div>

      <SectionTitle>ADMINS ({admins.length})</SectionTitle>
      <div className="flex flex-col gap-1.5">
        {admins.map(a => (
          <div key={a} className="flex items-center justify-between border border-border px-4 py-2.5 text-[10px]" style={{ background: "#FFFFFF" }}>
            <span className="font-bold">
              {a}
              {a === currentUsername && <span style={{ color: "rgba(17,17,16,0.35)" }}> (you)</span>}
            </span>
            <button
              disabled={busy || admins.length <= 1}
              onClick={() => handleDelete(a)}
              title={admins.length <= 1 ? "Can't remove the last remaining admin" : "Remove admin"}
              className="transition-opacity hover:opacity-60 disabled:opacity-20"
              style={{ color: "#B94040" }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Logs ────────────────────────────────────────────────────────────

function LogsTab() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchLogs().then(setLogs).catch(e => setError(e.message));
  }, []);

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <SectionTitle>RECENT ACTIVITY</SectionTitle>
      <div className="flex flex-col gap-1">
        {logs.map(log => (
          <div key={log.id} className="flex items-center gap-3 text-[10px] px-3 py-2 border border-border" style={{ background: "#FFFFFF" }}>
            <span className="w-40 flex-shrink-0" style={{ color: "rgba(17,17,16,0.35)" }}>
              {new Date(log.timestamp).toLocaleString()}
            </span>
            <span className="w-24 font-bold uppercase" style={{ color: "#C8A84B" }}>{log.action}</span>
            <span className="flex-1">{log.detail}</span>
            {log.floor != null && <span style={{ color: "rgba(17,17,16,0.4)" }}>F{log.floor}</span>}
          </div>
        ))}
        {logs.length === 0 && <div className="text-[10px]" style={{ color: "rgba(17,17,16,0.35)" }}>No activity yet.</div>}
      </div>
    </div>
  );
}

// ── Analytics ───────────────────────────────────────────────────────

const CHART_COLORS = ["#111110", "#C8A84B", "#3D8B5E", "#B94040", "#5B7FA5", "#8B6DB5"];

function AnalyticsTab({ lang }: { lang: Lang }) {
  const t = UI[lang];
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAnalytics().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <div className="text-[11px]" style={{ color: "rgba(17,17,16,0.4)" }}>{t.loadingSeats}</div>;

  const hasActivity = data.totalCheckins > 0;

  const peakHoursData = data.peakHours.map(h => ({
    hour: `${h.hour}:00`,
    count: h.count,
  }));

  const facilityData = data.facilityUsage.map(f => ({
    name: f.equipment === "power_outlet"
      ? (lang === "zh" ? "电源插座" : "Power Outlet")
      : f.equipment === "projector"
        ? (lang === "zh" ? "投影仪" : "Projector")
        : f.equipment,
    total: f.total,
    occupied: f.occupied,
    available: f.total - f.occupied,
  }));

  const zoneData = Object.entries(data.zoneStats).map(([zone, stats]) => ({
    name: zone === "quiet"
      ? (lang === "zh" ? "安静区" : "Quiet")
      : zone === "collaborative"
        ? (lang === "zh" ? "协作区" : "Collaborative")
        : zone,
    occupied: stats.occupied,
    available: stats.total - stats.occupied,
  }));

  const floorData = Object.entries(data.floorStats).map(([fl, stats]) => ({
    name: `${lang === "zh" ? "楼层" : "Floor"} ${fl}`,
    occupied: stats.occupied,
    available: stats.total - stats.occupied,
  }));

  return (
    <div className="space-y-8">
      {/* Overview cards */}
      <div>
        <SectionTitle>{t.analyticsOverview}</SectionTitle>
        <div className="grid grid-cols-3 gap-4 mt-3">
          {[
            { label: t.analyticsTotalCheckins, value: data.totalCheckins, color: "#3D8B5E" },
            { label: t.analyticsTotalCheckouts, value: data.totalCheckouts, color: "#B94040" },
            { label: t.analyticsSeatsUsed, value: data.uniqueSeatsUsed, color: "#C8A84B" },
          ].map(({ label, value, color }) => (
            <div key={label} className="border border-border px-4 py-4" style={{ background: "#FFFFFF" }}>
              <div className="text-[8px] tracking-[0.18em] mb-2" style={{ color: "rgba(17,17,16,0.4)" }}>{label}</div>
              <div className="text-2xl font-bold" style={{ color }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {!hasActivity && (
        <div className="text-[10px] border border-border px-4 py-3" style={{ background: "#FFFFFF", color: "rgba(17,17,16,0.45)" }}>
          {t.analyticsNoData}
        </div>
      )}

      {/* Peak Hours */}
      {hasActivity && (
        <div>
          <SectionTitle>{t.analyticsPeakHours}</SectionTitle>
          <p className="text-[10px] mb-3" style={{ color: "rgba(17,17,16,0.45)" }}>{t.analyticsPeakHoursDesc}</p>
          <div className="border border-border p-4" style={{ background: "#FFFFFF" }}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={peakHoursData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(17,17,16,0.08)" />
                <XAxis dataKey="hour" tick={{ fontSize: 9, fill: "rgba(17,17,16,0.5)" }} />
                <YAxis tick={{ fontSize: 9, fill: "rgba(17,17,16,0.5)" }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 10, border: "1px solid #e5e5e5" }} />
                <Bar dataKey="count" name={t.analyticsCheckins} fill="#111110" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Popular Seats */}
      {data.popularSeats.length > 0 && (
        <div>
          <SectionTitle>{t.analyticsPopularSeats}</SectionTitle>
          <p className="text-[10px] mb-3" style={{ color: "rgba(17,17,16,0.45)" }}>{t.analyticsPopularSeatsDesc}</p>
          <div className="flex flex-col gap-1">
            {data.popularSeats.map((s, i) => {
              const maxCount = data.popularSeats[0]?.count || 1;
              const pct = Math.round((s.count / maxCount) * 100);
              return (
                <div key={s.seatId} className="flex items-center gap-3 border border-border px-4 py-2.5" style={{ background: "#FFFFFF" }}>
                  <span className="text-[10px] font-bold w-6" style={{ color: "rgba(17,17,16,0.3)" }}>#{i + 1}</span>
                  <span className="text-[10px] font-bold w-28">{s.seatId}</span>
                  <div className="flex-1 h-1.5" style={{ background: "rgba(17,17,16,0.08)" }}>
                    <div className="h-full" style={{ width: `${pct}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />
                  </div>
                  <span className="text-[10px] w-10 text-right" style={{ color: "rgba(17,17,16,0.5)" }}>{s.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Facility Usage */}
      {facilityData.length > 0 && (
        <div>
          <SectionTitle>{t.analyticsFacilityUsage}</SectionTitle>
          <p className="text-[10px] mb-3" style={{ color: "rgba(17,17,16,0.45)" }}>{t.analyticsFacilityUsageDesc}</p>
          <div className="border border-border p-4" style={{ background: "#FFFFFF" }}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={facilityData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(17,17,16,0.08)" />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: "rgba(17,17,16,0.5)" }} />
                <YAxis tick={{ fontSize: 9, fill: "rgba(17,17,16,0.5)" }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 10, border: "1px solid #e5e5e5" }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="occupied" name={t.analyticsOccupied} stackId="a" fill="#B94040" />
                <Bar dataKey="available" name={t.analyticsAvailable} stackId="a" fill="#3D8B5E" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Unmet Demand */}
      {data.unmetDemand.length > 0 && (
        <div>
          <SectionTitle>{t.analyticsUnmetDemand}</SectionTitle>
          <p className="text-[10px] mb-3" style={{ color: "rgba(17,17,16,0.45)" }}>{t.analyticsUnmetDemandDesc}</p>
          <div className="flex flex-col gap-1">
            {data.unmetDemand.map((d, i) => {
              const maxCount = data.unmetDemand[0]?.occupiedCount || 1;
              const pct = Math.round((d.occupiedCount / maxCount) * 100);
              return (
                <div key={d.seatId} className="flex items-center gap-3 border border-border px-4 py-2.5" style={{ background: "#FFFFFF" }}>
                  <span className="text-[10px] font-bold w-6" style={{ color: "rgba(17,17,16,0.3)" }}>#{i + 1}</span>
                  <span className="text-[10px] font-bold w-28">{d.seatId}</span>
                  <div className="flex-1 h-1.5" style={{ background: "rgba(17,17,16,0.08)" }}>
                    <div className="h-full" style={{ width: `${pct}%`, background: "#B94040" }} />
                  </div>
                  <span className="text-[10px] w-16 text-right" style={{ color: "rgba(17,17,16,0.5)" }}>
                    {d.occupiedCount} {lang === "zh" ? "次" : "×"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Zone Breakdown */}
      {zoneData.length > 0 && (
        <div>
          <SectionTitle>{t.analyticsZoneBreakdown}</SectionTitle>
          <p className="text-[10px] mb-3" style={{ color: "rgba(17,17,16,0.45)" }}>{t.analyticsZoneBreakdownDesc}</p>
          <div className="border border-border p-4" style={{ background: "#FFFFFF" }}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={zoneData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(17,17,16,0.08)" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "rgba(17,17,16,0.5)" }} />
                <YAxis tick={{ fontSize: 9, fill: "rgba(17,17,16,0.5)" }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 10, border: "1px solid #e5e5e5" }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="occupied" name={t.analyticsOccupied} stackId="a" fill="#B94040" />
                <Bar dataKey="available" name={t.analyticsAvailable} stackId="a" fill="#3D8B5E" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Floor Breakdown */}
      {floorData.length > 0 && (
        <div>
          <SectionTitle>{t.analyticsFloorBreakdown}</SectionTitle>
          <p className="text-[10px] mb-3" style={{ color: "rgba(17,17,16,0.45)" }}>{t.analyticsFloorBreakdownDesc}</p>
          <div className="border border-border p-4" style={{ background: "#FFFFFF" }}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={floorData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(17,17,16,0.08)" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "rgba(17,17,16,0.5)" }} />
                <YAxis tick={{ fontSize: 9, fill: "rgba(17,17,16,0.5)" }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 10, border: "1px solid #e5e5e5" }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="occupied" name={t.analyticsOccupied} stackId="a" fill="#B94040" />
                <Bar dataKey="available" name={t.analyticsAvailable} stackId="a" fill="#3D8B5E" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Turnover */}
      {data.turnover.length > 0 && (
        <div>
          <SectionTitle>{t.analyticsTurnover}</SectionTitle>
          <p className="text-[10px] mb-3" style={{ color: "rgba(17,17,16,0.45)" }}>{t.analyticsTurnoverDesc}</p>
          <div className="border border-border p-4" style={{ background: "#FFFFFF" }}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={data.turnover}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(17,17,16,0.08)" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "rgba(17,17,16,0.5)" }} />
                <YAxis tick={{ fontSize: 9, fill: "rgba(17,17,16,0.5)" }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 10, border: "1px solid #e5e5e5" }} />
                <Bar dataKey="count" name={t.analyticsTurnovers} fill="#C8A84B" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
