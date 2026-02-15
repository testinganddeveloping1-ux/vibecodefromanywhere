import React from "react";
import type { EventItem } from "../types";
import { formatInputForDisplay } from "../lib/text";

export function HistoryBar(props: { events: EventItem[] }) {
  const items = (props.events ?? [])
    .filter(
      (e) =>
        e.kind === "input" ||
        e.kind === "interrupt" ||
        e.kind === "stop" ||
        e.kind === "kill" ||
        e.kind === "inbox.respond" ||
        e.kind === "inbox.dismiss",
    )
    .slice(-8);

  if (!items.length) return null;
  return (
    <div className="historyBar">
      <span className="chip mono">recent</span>
      <div className="historyScroll">
        {items.map((e) => (
          <div key={e.id} className={`historyItem ${e.kind === "input" ? "historyInput" : "historyAction"}`}>
            <span className="mono">
              {e.kind === "input"
                ? formatInputForDisplay(e.data?.text ?? "").slice(0, 44)
                : e.kind === "inbox.respond"
                  ? `INBOX:${String(e.data?.optionId ?? "").slice(0, 6) || "OK"}`
                  : e.kind === "inbox.dismiss"
                    ? "INBOX:DISMISS"
                    : e.kind.toUpperCase()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

