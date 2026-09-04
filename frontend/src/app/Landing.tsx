import { Link } from "react-router";
import { GraduationCap, ShieldCheck, Sparkles, ArrowRight, Languages } from "lucide-react";
import { UI, useLang } from "./i18n";

export default function Landing() {
  const [lang, toggleLang] = useLang();
  const t = UI[lang];

  return (
    <div
      className="size-full flex flex-col items-center justify-center bg-background text-foreground px-6 relative"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      <button
        onClick={toggleLang}
        className="absolute top-4 right-4 flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold border border-border transition-colors hover:border-[#C8A84B]"
        style={{ color: "rgba(17,17,16,0.6)" }}
      >
        <Languages size={11} /> {t.langToggleLabel}
      </button>

      <div className="flex items-center gap-1.5 text-[9px] tracking-[0.18em] mb-2" style={{ color: "#C8A84B" }}>
        <Sparkles size={10} />
        {t.brandSub.toUpperCase()}
      </div>
      <div className="text-xl font-bold tracking-widest mb-1">SEAT FINDER</div>
      <div className="text-[10px] mb-10" style={{ color: "rgba(17,17,16,0.45)" }}>
        {t.university}
      </div>

      <div className="flex flex-col sm:flex-row gap-4 w-full max-w-xl">
        <Link
          to="/finder"
          className="group flex-1 flex flex-col gap-3 px-6 py-8 border border-border transition-colors hover:border-[#3D8B5E]"
          style={{ background: "#FAFAF8" }}
        >
          <GraduationCap size={20} style={{ color: "#3D8B5E" }} />
          <div className="text-sm font-bold">{t.imStudent}</div>
          <div className="text-[10px] leading-relaxed" style={{ color: "rgba(17,17,16,0.5)" }}>
            {t.studentPitch}
          </div>
          <div
            className="mt-2 flex items-center gap-1.5 text-[9px] font-bold tracking-wide transition-opacity opacity-60 group-hover:opacity-100"
            style={{ color: "#3D8B5E" }}
          >
            {t.findASeat} <ArrowRight size={11} />
          </div>
        </Link>

        <Link
          to="/admin"
          className="group flex-1 flex flex-col gap-3 px-6 py-8 border border-border transition-colors hover:border-[#C8A84B]"
          style={{ background: "#FAFAF8" }}
        >
          <ShieldCheck size={20} style={{ color: "#C8A84B" }} />
          <div className="text-sm font-bold">{t.imStaff}</div>
          <div className="text-[10px] leading-relaxed" style={{ color: "rgba(17,17,16,0.5)" }}>
            {t.staffPitch}
          </div>
          <div
            className="mt-2 flex items-center gap-1.5 text-[9px] font-bold tracking-wide transition-opacity opacity-60 group-hover:opacity-100"
            style={{ color: "#C8A84B" }}
          >
            {t.adminLogin} <ArrowRight size={11} />
          </div>
        </Link>
      </div>

      <Link to="/faq" className="mt-8 text-[9px] transition-opacity hover:opacity-60" style={{ color: "rgba(17,17,16,0.35)" }}>
        {t.faqTitle}
      </Link>
    </div>
  );
}
