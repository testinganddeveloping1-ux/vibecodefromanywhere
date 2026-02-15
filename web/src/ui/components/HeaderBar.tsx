import React from "react";
import type { SessionRow } from "../types";
import { IconSettings } from "./icons";

export function HeaderBar(props: {
  online: boolean;
  globalWsState: "closed" | "connecting" | "open";
  activeSession: SessionRow | null;
  onOpenSettings: () => void;
}) {
  const status = !props.online
    ? "offline"
    : props.globalWsState === "open"
      ? "live"
      : props.globalWsState === "connecting"
        ? "reconnecting"
        : "disconnected";
  const chipOn = props.online && props.globalWsState === "open";

  return (
    <header className="hdr">
      <div className="hdrLeft">
        <div className="logo">FYP</div>
        <div className="hdrText">
          <div className="hdrTitle">FromYourPhone</div>
          <div className="hdrMeta">
            <span className={`chip ${chipOn ? "chipOn" : ""}`}>{status}</span>
            {props.activeSession ? <span className="chip mono" style={{ fontSize: 10 }}>{props.activeSession.tool}</span> : null}
          </div>
        </div>
      </div>
      <div className="hdrRight">
        <button
          className="btn ghost"
          onClick={props.onOpenSettings}
          aria-label="Settings"
          style={{ padding: "8px 10px" }}
        >
          <IconSettings />
        </button>
      </div>
    </header>
  );
}

