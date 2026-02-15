import React from "react";
import type { TabId } from "../types";
import { IconFolder, IconInbox, IconPlus, IconTerminal } from "./icons";

export function BottomNav(props: {
  tab: TabId;
  inboxCount: number;
  onSetTab: (tab: TabId) => void;
  onOpenInbox: () => void;
}) {
  return (
    <nav className="nav">
      <button className={`navBtn ${props.tab === "run" ? "navOn" : ""}`} onClick={() => props.onSetTab("run")}>
        <IconTerminal />
        <span className="navLabel">Terminal</span>
      </button>
      <button className={`navBtn ${props.tab === "workspace" ? "navOn" : ""}`} onClick={() => props.onSetTab("workspace")}>
        <IconFolder />
        <span className="navLabel">Projects</span>
      </button>
      <button
        className={`navBtn ${props.tab === "inbox" ? "navOn" : ""}`}
        onClick={() => props.onOpenInbox()}
      >
        <IconInbox />
        <span className="navLabel">Inbox</span>
        {props.inboxCount > 0 ? <span className="navBadge">{props.inboxCount}</span> : null}
      </button>
      <button className={`navBtn ${props.tab === "new" ? "navOn" : ""}`} onClick={() => props.onSetTab("new")}>
        <IconPlus />
        <span className="navLabel">New</span>
      </button>
    </nav>
  );
}

