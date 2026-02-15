import React from "react";
import type { SessionRow } from "../types";

export function PinnedSlotsBar(props: {
  slots: number;
  activeId: string | null;
  pinnedBySlot: Record<number, SessionRow>;
  onOpenSession: (id: string) => void;
}) {
  const slots = Math.min(6, Math.max(1, Math.floor(props.slots || 3)));
  const filled = Object.values(props.pinnedBySlot).filter(Boolean);
  if (!filled.length) return null;
  return (
    <div className="pinBar">
      {Array.from({ length: slots }).map((_, idx) => {
        const slot = idx + 1;
        const s = props.pinnedBySlot[slot] ?? null;
        if (!s) return null;
        const on = s.id === props.activeId;
        const hasAttention = (s.attention ?? 0) > 0;
        return (
          <button
            key={slot}
            className={`pinPill ${on ? "pinPillOn" : ""}`}
            onClick={() => props.onOpenSession(s.id)}
            aria-label={`Slot ${slot}: ${s.label || s.profileId}`}
          >
            <span className="pinPillNum">{slot}</span>
            <span className="pinPillLabel">{s.label || s.tool}</span>
            {hasAttention ? <span className="pinPillDot" /> : null}
            {s.running ? <span className="pinPillRun" /> : null}
          </button>
        );
      })}
    </div>
  );
}
