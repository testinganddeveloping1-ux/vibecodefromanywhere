import React from "react";
import type { SessionRow } from "../types";
import { IconSettings, IconLogo } from "./icons";
import styles from "./HeaderBar.module.css";

export function HeaderBar(props: {
  online: boolean;
  globalWsState: "closed" | "connecting" | "open";
  activeSession: SessionRow | null;
  activeSessionRunning?: boolean;
  onOpenSettings: () => void;
}) {
  const connected = props.online && props.globalWsState === "open";

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <div className={styles.logo}>
          <IconLogo />
        </div>

        {/* Connection dot — sleek dynamic pill */}
        <div className={styles.statusPill} title={connected ? "Connected" : "Disconnected"}>
          <div className={`${styles.dot} ${connected ? styles.dotOnline : ""}`} />
        </div>

        {/* Session context when actively viewing a session */}
        {props.activeSession && (
          <div className={styles.contextPill}>
            <span className={styles.sessionTool}>{props.activeSession.tool}</span>
            {props.activeSessionRunning && <span className={styles.liveRipple} />}
          </div>
        )}
      </div>

      <div className={styles.right}>
        <button className={styles.settingsBtn} onClick={props.onOpenSettings} aria-label="Settings">
          <IconSettings />
        </button>
      </div>
    </header>
  );
}
