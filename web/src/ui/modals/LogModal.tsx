import React from "react";
import type { EventItem } from "../types";
import { formatEventLine } from "../lib/text";

export function LogModal(props: { open: boolean; events: EventItem[]; onClose: () => void }) {
  if (!props.open) return null;
  const events = props.events ?? [];
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modalHead">
          <b>Session Log</b>
          <span className="chip">{events.length}</span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
        <div className="modalBody">
          <div className="list">
            {events.slice(-200).map((e) => (
              <div key={e.id} className="listRow" style={{ cursor: "default" }}>
                <div className="listLeft">
                  <span className="chip">{e.kind}</span>
                  <div className="listText">
                    <div className="listTitle mono">{formatEventLine(e).slice(0, 320)}</div>
                    <div className="listSub mono">{new Date(e.ts).toLocaleString()}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="help">This includes your inputs plus actions (interrupt/stop/kill) and approval decisions.</div>
        </div>
      </div>
    </div>
  );
}

