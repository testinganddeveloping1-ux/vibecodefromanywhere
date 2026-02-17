import React, { useEffect, useRef } from "react";
import type { TabId } from "../types";
import { IconFolder, IconInbox, IconPlus, IconTerminal } from "./icons";

export function BottomNav(props: {
  tab: TabId;
  inboxCount: number;
  onSetTab: (tab: TabId) => void;
  onOpenInbox: () => void;
}) {
  const navRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const root = document.documentElement;

    let ro: ResizeObserver | null = null;
    let raf = 0;

    const readPx = (raw: string): number => {
      const n = Number.parseFloat(String(raw || "").trim());
      return Number.isFinite(n) ? n : 0;
    };

    const update = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          const rectH = el.getBoundingClientRect().height;
          const safeB = readPx(getComputedStyle(root).getPropertyValue("--safe-b"));
          // Our CSS already adds --safe-b separately. Keep --nav-h as the "base" nav height.
          const baseH = Math.max(0, rectH - safeB);
          const rounded = Math.round(baseH);
          if (rounded >= 40 && rounded <= 96) root.style.setProperty("--nav-h", `${rounded}px`);
        } catch {
          // ignore
        }
      });
    };

    update();
    ro = new ResizeObserver(() => update());
    ro.observe(el);

    window.addEventListener("resize", update, { passive: true } as any);
    window.addEventListener("orientationchange", update, { passive: true } as any);
    const vv: any = (window as any).visualViewport;
    vv?.addEventListener?.("resize", update, { passive: true } as any);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", update as any);
      window.removeEventListener("orientationchange", update as any);
      vv?.removeEventListener?.("resize", update as any);
    };
  }, []);

  return (
    <nav className="nav" ref={navRef as any}>
      <button
        className={`navBtn ${props.tab === "run" ? "navOn" : ""}`}
        aria-label="Terminal"
        title="Terminal"
        onClick={() => props.onSetTab("run")}
      >
        <IconTerminal />
        <span className="navLabel">Terminal</span>
      </button>
      <button
        className={`navBtn ${props.tab === "workspace" ? "navOn" : ""}`}
        aria-label="Projects"
        title="Projects"
        onClick={() => props.onSetTab("workspace")}
      >
        <IconFolder />
        <span className="navLabel">Projects</span>
      </button>
      <button
        className={`navBtn ${props.tab === "inbox" ? "navOn" : ""}`}
        aria-label="Inbox"
        title="Inbox"
        onClick={() => props.onOpenInbox()}
      >
        <IconInbox />
        <span className="navLabel">Inbox</span>
        {props.inboxCount > 0 ? <span className="navBadge">{props.inboxCount}</span> : null}
      </button>
      <button
        className={`navBtn ${props.tab === "new" ? "navOn" : ""}`}
        aria-label="New"
        title="New"
        onClick={() => props.onSetTab("new")}
      >
        <IconPlus />
        <span className="navLabel">New</span>
      </button>
    </nav>
  );
}
