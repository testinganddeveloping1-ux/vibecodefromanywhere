import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
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
