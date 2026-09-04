import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowLeft, ChevronDown, Languages, GraduationCap, ShieldCheck } from "lucide-react";
import { UI, FAQ, useLang } from "./i18n";

type Role = "students" | "admins";

export default function Faq() {
  const [lang, toggleLang] = useLang();
  const t = UI[lang];
  const [searchParams] = useSearchParams();
  const initialRole: Role = searchParams.get("role") === "admin" ? "admins" : "students";
  const [role, setRole] = useState<Role>(initialRole);
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const items = FAQ[lang][role];

  return (
    <div
      className="size-full flex flex-col items-center bg-background text-foreground px-6 py-10 overflow-y-auto"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      <div className="w-full max-w-2xl">
        <div className="flex items-center justify-between mb-8">
          <Link to="/" className="flex items-center gap-1.5 text-[10px] transition-opacity hover:opacity-60" style={{ color: "rgba(17,17,16,0.5)" }}>
            <ArrowLeft size={11} /> {t.faqBack}
          </Link>
          <button
            onClick={toggleLang}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold border border-border transition-colors hover:border-[#C8A84B]"
            style={{ color: "rgba(17,17,16,0.6)" }}
          >
            <Languages size={11} /> {t.langToggleLabel}
          </button>
        </div>

        <div className="text-lg font-bold tracking-widest mb-6">{t.faqTitle.toUpperCase()}</div>

        <div className="flex gap-2 mb-8">
          <button
            onClick={() => { setRole("students"); setOpenIndex(0); }}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-[10px] font-bold border transition-colors"
            style={{
              background: role === "students" ? "#111110" : "#FAFAF8",
              color: role === "students" ? "#F0EDE6" : "rgba(17,17,16,0.5)",
              borderColor: role === "students" ? "#111110" : "var(--border)",
            }}
          >
            <GraduationCap size={12} /> {t.faqForStudents}
          </button>
          <button
            onClick={() => { setRole("admins"); setOpenIndex(0); }}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-[10px] font-bold border transition-colors"
            style={{
              background: role === "admins" ? "#111110" : "#FAFAF8",
              color: role === "admins" ? "#F0EDE6" : "rgba(17,17,16,0.5)",
              borderColor: role === "admins" ? "#111110" : "var(--border)",
            }}
          >
            <ShieldCheck size={12} /> {t.faqForAdmins}
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {items.map((item, i) => {
            const isOpen = openIndex === i;
            return (
              <div key={i} className="border border-border" style={{ background: "#FAFAF8" }}>
                <button
                  onClick={() => setOpenIndex(isOpen ? null : i)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left text-[11px] font-bold"
                >
                  {item.q}
                  <ChevronDown
                    size={13}
                    className="flex-shrink-0 transition-transform"
                    style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", color: "#C8A84B" }}
                  />
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 text-[10px] leading-relaxed" style={{ color: "rgba(17,17,16,0.6)" }}>
                    {item.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
