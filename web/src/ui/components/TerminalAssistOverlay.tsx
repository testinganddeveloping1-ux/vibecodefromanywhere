import React from "react";
import type { TuiAssist } from "../types";
import { Button } from "./Button";
import { Chip } from "./Chip";
import styles from "./TerminalAssistOverlay.module.css";

export function TerminalAssistOverlay(props: {
  assist: TuiAssist;
  onHide: () => void;
  onSend: (send: string) => void;
}) {
  const a = props.assist;
  return (
    <div className={styles.overlay} aria-label="Terminal assist">
      <div className={styles.card}>
        <div className={styles.head}>
          <Chip>assist</Chip>
          <span className={styles.title}>{a.title}</span>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={props.onHide}>
            Hide
          </Button>
        </div>
        {a.body ? <div className={styles.body}>{a.body}</div> : null}
        <div className={styles.actions}>
          {(a.options ?? []).slice(0, 12).map((o) => {
            const label = String(o.label ?? "");
            const low = label.toLowerCase();
            const isNav =
              low === "up" ||
              low === "down" ||
              low === "tab" ||
              low === "shift+tab" ||
              low === "esc";
            const isEnter = low === "enter";
            const variant = isEnter ? "primary" : isNav ? "ghost" : "default";
            return (
              <Button
                key={o.id}
                variant={variant}
                onClick={() => props.onSend(String(o.send ?? ""))}
              >
                {label}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
