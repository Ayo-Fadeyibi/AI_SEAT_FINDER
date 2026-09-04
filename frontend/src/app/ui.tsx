import { AlertTriangle } from "lucide-react";

/** Small shared presentational bits used by both Admin.tsx and
 * LayoutEditor.tsx — kept in their own file so those two can import each
 * other's default export (Admin renders LayoutEditor) without a cycle. */

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] px-3 py-2.5 mb-4" style={{ background: "#B940400C", borderLeft: "2px solid #B94040", color: "#B94040" }}>
      <AlertTriangle size={12} />
      {message}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] tracking-[0.22em] mb-3" style={{ color: "rgba(17,17,16,0.4)" }}>
      {children}
    </div>
  );
}
