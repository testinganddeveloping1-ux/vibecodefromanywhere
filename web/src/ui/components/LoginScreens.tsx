import React from "react";

export function ConnectingScreen() {
  return (
    <div className="login">
      <div style={{ textAlign: "center" }}>
        <div className="logo" style={{ width: 48, height: 48, fontSize: 14, margin: "0 auto 12px" }}>
          FYP
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
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
  onUnlock: () => void;
  onRetry: () => void;
  onPair: () => void | Promise<void>;
}) {
  return (
    <div className="login">
      <div className="loginCard">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div className="logo" style={{ width: 38, height: 38, fontSize: 12 }}>
            FYP
          </div>
          <div className="loginTitle">FromYourPhone</div>
        </div>
        <div className="loginSub">Scan the Pair QR code (recommended) or paste the token from the host terminal.</div>

        <div className="loginHint" style={{ marginTop: 8 }}>
          Pair is easiest: scan the Pair QR from the host. You should only need this once per device.
        </div>
        <div className="loginActions" style={{ marginTop: 10 }}>
          <input
            value={props.pairCode}
            onChange={(e) => props.setPairCode(e.target.value)}
            placeholder="pair code (8 chars)"
            autoCapitalize="characters"
            autoCorrect="off"
          />
          <button className="btn" onClick={props.onPair}>
            Pair
          </button>
        </div>
        {props.pairMsg ? <div className="loginHint">{props.pairMsg}</div> : null}

        <div className="loginHint" style={{ marginTop: 10 }}>
          Fallback: paste the long token (printed on the host) to unlock.
        </div>
        <input
          value={props.token}
          onChange={(e) => props.setToken(e.target.value)}
          placeholder="token..."
          autoCapitalize="none"
          autoCorrect="off"
        />
        <div className="loginActions">
          <button className="btn primary" onClick={props.onUnlock}>
            Unlock
          </button>
          <button className="btn" onClick={props.onRetry}>
            Retry
          </button>
        </div>
        <div className="loginHint">After first unlock/pair, your device stores an httpOnly cookie so you usually will not be asked again.</div>
      </div>
    </div>
  );
}
