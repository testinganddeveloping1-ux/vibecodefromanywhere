import React from "react";
import type { TuiAssist } from "../types";

export function TerminalAssistOverlay(props: {
  assist: TuiAssist;
  onHide: () => void;
  onSend: (send: string) => void;
}) {
  const a = props.assist;
  return (
    <div className="assistOverlay" aria-label="Terminal assist">
      <div className="assistCard">
        <div className="assistHead">
          <span className="chip">assist</span>
          <span className="mono assistTitle">{a.title}</span>
          <div className="spacer" />
          <button className="btn ghost" onClick={props.onHide}>
            Hide
          </button>
        </div>
        {a.body ? <div className="assistBody mono">{a.body}</div> : null}
        <div className="assistActions">
          {(a.options ?? []).slice(0, 12).map((o) => {
            const label = String(o.label ?? "");
            const low = label.toLowerCase();
            const isNav = low === "up" || low === "down" || low === "tab" || low === "shift+tab" || low === "esc";
            const isEnter = low === "enter";
            const cls = isEnter ? "btn primary" : isNav ? "btn ghost" : "btn";
            return (
              <button key={o.id} className={cls} onClick={() => props.onSend(String(o.send ?? ""))}>
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

