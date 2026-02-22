import React, { useEffect, useRef, useState } from "react";
import type { SessionRow } from "../types";

export function TerminalView({ session }: { session: SessionRow | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dataSubRef = useRef<{ dispose?: () => void } | null>(null);
  const sessionId = session?.id ?? null;

  useEffect(() => {
    if (!sessionId || !containerRef.current) return;

    let isSubscribed = true;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (!isSubscribed) return;
      if (!termRef.current) {
        termRef.current = new Terminal({
          theme: { background: "var(--bg0)", foreground: "#f0f4f8", cursor: "#ff8a3d", selectionBackground: "rgba(255, 138, 61, 0.3)" },
          fontFamily: "var(--mono)",
          fontSize: 14,
          cursorBlink: true,
          disableStdin: false,
        });
        fitRef.current = new FitAddon();
        termRef.current.loadAddon(fitRef.current);
        termRef.current.open(containerRef.current);
      }

      fitRef.current.fit();

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      wsRef.current = new WebSocket(`${protocol}//${host}/ws/sessions/${sessionId}`);

      const sendResize = () => {
        const term = termRef.current;
        const ws = wsRef.current;
        if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "resize", cols: Number(term.cols || 0), rows: Number(term.rows || 0) }));
      };

      wsRef.current.onopen = () => {
        sendResize();
      };

      wsRef.current.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "output" && typeof msg.chunk === "string") {
            termRef.current?.write(msg.chunk);
          } else if (msg.type === "output" && typeof msg.text === "string") {
            termRef.current?.write(msg.text);
          } else if (msg.type === "transcript" && typeof msg.text === "string") {
            termRef.current?.clear();
            termRef.current?.write(msg.text);
          } else if (msg.type === "session.stopped") {
            termRef.current?.write("\r\n[session stopped]\r\n");
          } else if (msg.type === "input.error" && typeof msg.message === "string") {
            termRef.current?.write(`\r\n[input error] ${msg.message}\r\n`);
          }
        } catch { }
      };

      dataSubRef.current?.dispose?.();
      dataSubRef.current = termRef.current.onData((data: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "input", text: data }));
        }
      });

      setTimeout(sendResize, 60);
    })();

    const handleResize = () => {
      fitRef.current?.fit();
      const term = termRef.current;
      const ws = wsRef.current;
      if (term && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: Number(term.cols || 0), rows: Number(term.rows || 0) }));
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      isSubscribed = false;
      window.removeEventListener("resize", handleResize);
      dataSubRef.current?.dispose?.();
      dataSubRef.current = null;
      wsRef.current?.close();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  return (
    <div style={{ flex: 1, minHeight: 0, padding: 8, background: "var(--bg0)", borderTop: "1px solid var(--edge)", borderRadius: "var(--r-md)" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
