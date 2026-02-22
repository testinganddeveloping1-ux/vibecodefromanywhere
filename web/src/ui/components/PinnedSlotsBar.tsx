import React from "react";
import type { SessionRow } from "../types";
import styles from "./PinnedSlotsBar.module.css";

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
    <div className={styles.bar}>
      {Array.from({ length: slots }).map((_, idx) => {
        const slot = idx + 1;
        const s = props.pinnedBySlot[slot] ?? null;
        if (!s) return null;
        const on = s.id === props.activeId;
        const hasAttention = (s.attention ?? 0) > 0;
        return (
          <button
            key={slot}
            className={[styles.pill, on ? styles.pillActive : null].filter(Boolean).join(" ")}
            onClick={() => props.onOpenSession(s.id)}
            aria-label={`Slot ${slot}: ${s.label || s.profileId}`}
          >
            <span className={styles.num}>{slot}</span>
            <span className={styles.label}>{s.label || s.tool}</span>
            {hasAttention ? <span className={styles.dot} /> : null}
            {s.running ? <span className={styles.run} /> : null}
          </button>
        );
      })}
    </div>
  );
}
