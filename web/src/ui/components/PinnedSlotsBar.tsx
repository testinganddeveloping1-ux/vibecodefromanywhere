import React from "react";
import type { SessionRow } from "../types";

export function PinnedSlotsBar(props: {
  slots: number;
  activeId: string | null;
  pinnedBySlot: Record<number, SessionRow>;
  onOpenSession: (id: string) => void;
  onOpenWorkspace: () => void;
  onTogglePin: (id: string) => void;
}) {
  const slots = Math.min(6, Math.max(1, Math.floor(props.slots || 3)));
  return (
    <div className="pinBar">
      {Array.from({ length: slots }).map((_, idx) => {
        const slot = idx + 1;
        const s = props.pinnedBySlot[slot] ?? null;
        const on = s?.id && s.id === props.activeId;
        return (
          <div
            key={slot}
            className={`pinSlot ${on ? "pinOn" : ""} ${s ? "pinFilled" : "pinEmpty"}`}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (s?.id) props.onOpenSession(s.id);
              else props.onOpenWorkspace();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (s?.id) props.onOpenSession(s.id);
                else props.onOpenWorkspace();
              }
            }}
            aria-label={s?.id ? `Pinned session ${slot}` : `Empty slot ${slot}`}
          >
            <div className="pinTop">
              <span className="pinIdx mono">{slot}</span>
              {s ? <span className="chip chipOn">{s.tool}</span> : <span className="chip">empty</span>}
              <div className="spacer" />
              {s ? (
                <button
                  className="pinX"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onTogglePin(s.id);
                  }}
                >
                  Unpin
                </button>
              ) : null}
            </div>
            <div className="pinMain mono">{s ? (s.label ? s.label : s.profileId) : "Tap to open Workspace"}</div>
            {s?.attention && s.attention > 0 ? (
              <div className="pinBadgeRow">
                <span className="badge">{s.attention} waiting</span>
              </div>
            ) : null}
            {s?.preview ? <div className="pinSub mono">{s.preview}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
