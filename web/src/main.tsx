import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";

function bootFail(details: string) {
  try {
    const fn = (window as any).__FYP_BOOT_FAIL;
    if (typeof fn === "function") fn(details);
  } catch {
    // ignore
  }
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { details: string | null }> {
  state: { details: string | null } = { details: null };

  componentDidCatch(error: any, info: any) {
    const msg = String(error?.stack || error?.message || error || "unknown error");
    const stack = typeof info?.componentStack === "string" ? info.componentStack : "";
    const details = stack ? `${msg}\n\nReact component stack:\n${stack}` : msg;
    this.setState({ details });
    bootFail(details);
  }

  render() {
    if (this.state.details) {
      return (
        <div className="login">
          <div className="loginCard">
            <div className="loginTitle">UI crashed</div>
            <div className="loginSub">Copy the error below and send it to the host. Then reload.</div>
            <pre
              className="mono"
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 12,
                border: "1px solid var(--edge)",
                background: "var(--bg2)",
                color: "var(--ink2)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                userSelect: "text",
                maxHeight: "45vh",
                overflow: "auto",
              }}
            >
              {this.state.details}
            </pre>
            <div className="loginActions" style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => window.location.reload()}>
                Reload
              </button>
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(this.state.details ?? "");
                  } catch {
                    // ignore
                  }
                }}
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root");
createRoot(rootEl).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);

// Tell the inline boot screen that React mounted successfully.
try {
  const fn = (window as any).__FYP_BOOT_OK;
  if (typeof fn === "function") {
    requestAnimationFrame(() => requestAnimationFrame(() => fn()));
  }
} catch {
  // ignore
}
