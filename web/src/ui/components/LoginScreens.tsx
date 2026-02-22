import React from "react";
import { IconLogo } from "./icons";
import styles from "./LoginScreens.module.css";

export function ConnectingScreen() {
  return (
    <div className={styles.container}>
      <div className={styles.card} style={{ alignItems: "center", justifyContent: "center", padding: "48px 24px", maxWidth: "320px" }}>
        <div className={styles.logoBox} style={{ width: 64, height: 64, borderRadius: 20 }}>
          <IconLogo />
        </div>
        <div className={styles.title} style={{ fontSize: 18, marginTop: "8px" }}>
          Connecting...
        </div>
      </div>
    </div>
  );
}

export function UnlockScreen(props: {
  token: string;
  setToken: (v: string) => void;
  pairCode: string;
  setPairCode: (v: string) => void;
  pairMsg: string | null;
  unlockMsg: string | null;
  onUnlock: () => void;
  onRetry: () => void;
  onPair: () => void | Promise<void>;
}) {
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.logoBox}>
            <IconLogo />
          </div>
          <div className={styles.title}>FromYourPhone</div>
          <div className={styles.subtitle}>Unlock or pair device to sync terminals and workspace instantly.</div>
        </div>

        <div className={styles.inputGroup}>
          <div className={styles.label}>Pair Code (Recommended)</div>
          <input
            className={styles.input}
            value={props.pairCode}
            onChange={(e) => props.setPairCode(e.target.value)}
            placeholder="8-char code from host screen"
            autoCapitalize="characters"
            autoCorrect="off"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void props.onPair();
              }
            }}
          />
        </div>

        <div className={styles.actions}>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={props.onPair} style={{ flex: 1 }}>
            Pair Device
          </button>
        </div>

        {props.pairMsg && <div className={styles.message}>{props.pairMsg}</div>}

        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "12px 0" }} />

        <div className={styles.inputGroup}>
          <div className={styles.label}>Token Fallback</div>
          <input
            className={styles.input}
            value={props.token}
            onChange={(e) => props.setToken(e.target.value)}
            placeholder="Long connection token..."
            autoCapitalize="none"
            autoCorrect="off"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                props.onUnlock();
              }
            }}
          />
        </div>

        <div className={styles.actions}>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={props.onUnlock}>
            Unlock
          </button>
          <button className={styles.btn} onClick={props.onRetry} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.1)" }}>
            Retry
          </button>
        </div>

        {props.unlockMsg && <div className={styles.message}>{props.unlockMsg}</div>}

        <div className={styles.hint}>
          A secure cookie will keep you paired on this device.
        </div>
      </div>
    </div>
  );
}
