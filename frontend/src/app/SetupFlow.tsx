import { useState, useEffect, useCallback } from "react";
import { Map as MapIcon, Camera as CameraIcon, Lock, ArrowRight } from "lucide-react";
import { fetchLayout } from "./api";
import LayoutEditor from "./LayoutEditor";
import CamerasTab from "./CameraCalibration";
import { PALETTE } from "./constants";
import { type Lang, UI } from "./i18n";

type Step = 1 | 2;

/** Couples the two setup phases into one guided flow: build the floor plan,
 * then calibrate cameras against it. Step 2 stays locked until the saved
 * layout actually has seats — you can't calibrate seats that don't exist. */
export default function SetupFlow({ lang }: { lang: Lang }) {
  const t = UI[lang];
  const [step, setStep] = useState<Step>(1);
  const [seatCount, setSeatCount] = useState<number | null>(null);

  const refreshSeatCount = useCallback(() => {
    fetchLayout()
      .then(l => setSeatCount(l.objects.filter(o => o.type === "seat").length))
      .catch(() => setSeatCount(0));
  }, []);

  useEffect(() => { refreshSeatCount(); }, [refreshSeatCount]);

  const canCalibrate = (seatCount ?? 0) > 0;

  const StepChip = ({ n, label, Icon, active, locked, onClick }: {
    n: number; label: string; Icon: typeof MapIcon; active: boolean; locked?: boolean; onClick: () => void;
  }) => (
    <button
      onClick={onClick}
      disabled={locked}
      id={n === 1 ? "tour-setup-step1" : "tour-setup-step2"}
      title={locked ? t.setupStep2Locked : ""}
      className="flex items-center gap-2 px-3 py-2 text-[10px] font-bold transition-colors disabled:cursor-not-allowed"
      style={{
        background: active ? "#111110" : "rgba(17,17,16,0.05)",
        color: active ? "#F0EDE6" : locked ? "rgba(17,17,16,0.3)" : "rgba(17,17,16,0.6)",
        border: `1px solid ${active ? PALETTE.gold : "transparent"}`,
      }}
    >
      <span
        className="flex items-center justify-center w-4 h-4 rounded-full text-[9px]"
        style={{ background: active ? PALETTE.gold : "rgba(17,17,16,0.15)", color: active ? "#111" : "inherit" }}
      >
        {n}
      </span>
      {locked ? <Lock size={11} /> : <Icon size={12} />}
      {label}
    </button>
  );

  return (
    <div>
      {/* Step header */}
      <div className="flex items-center gap-2 mb-5">
        <StepChip n={1} label={t.stepBuildPlan} Icon={MapIcon} active={step === 1} onClick={() => setStep(1)} />
        <ArrowRight size={13} style={{ color: "rgba(17,17,16,0.25)" }} />
        <StepChip n={2} label={t.stepCalibrate} Icon={CameraIcon} active={step === 2} locked={!canCalibrate} onClick={() => canCalibrate && setStep(2)} />
      </div>

      {step === 1 && (
        <>
          <LayoutEditor onSaved={refreshSeatCount} />
          {canCalibrate && (
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => setStep(2)}
                className="flex items-center gap-1.5 px-3 py-2 text-[9px] font-bold"
                style={{ background: PALETTE.gold, color: "#111" }}
              >
                {t.setupContinue} <ArrowRight size={12} />
              </button>
            </div>
          )}
        </>
      )}

      {step === 2 && (
        canCalibrate
          ? <CamerasTab lang={lang} />
          : (
            <div className="flex flex-col items-center gap-3 py-16 border border-dashed border-border">
              <Lock size={18} style={{ color: "rgba(17,17,16,0.4)" }} />
              <div className="text-[11px] font-bold">{t.setupStep2Locked}</div>
              <button
                onClick={() => setStep(1)}
                className="px-3 py-2 text-[9px] font-bold"
                style={{ background: "#111110", color: "#F0EDE6" }}
              >
                {t.stepBuildPlan}
              </button>
            </div>
          )
      )}
    </div>
  );
}
