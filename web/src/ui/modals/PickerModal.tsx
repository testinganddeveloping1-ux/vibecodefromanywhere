import React from "react";

export type PickerEntry = { name: string; path: string; kind: string };

export function PickerModal(props: {
  open: boolean;
  path: string;
  parent: string | null;
  entries: PickerEntry[];
  showHidden: boolean;
  onClose: () => void;
  onUse: (path: string) => void;
  onSetPath: (path: string) => void;
  onGo: (path: string) => void | Promise<void>;
  onUp: (parent: string) => void | Promise<void>;
  onToggleHidden: (next: boolean) => void | Promise<void>;
}) {
  if (!props.open) return null;
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modalHead">
          <b>Pick Workspace Folder</b>
          <span className="chip mono">{props.path || ""}</span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
          <button className="btn primary" onClick={() => props.onUse(props.path)}>
            Use
          </button>
        </div>
        <div className="modalBody">
          <div className="inline">
            <input
              value={props.path}
              onChange={(e) => props.onSetPath(e.target.value)}
              placeholder="/path/to/workspace"
              autoCapitalize="none"
              autoCorrect="off"
            />
            <button className="btn" onClick={() => props.onGo(props.path)}>
              Go
            </button>
            {props.parent ? (
              <button className="btn" onClick={() => props.onUp(props.parent!)}>
                Up
              </button>
            ) : null}
            <button
              className={`btn ${props.showHidden ? "primary" : "ghost"}`}
              onClick={() => props.onToggleHidden(!props.showHidden)}
            >
              {props.showHidden ? "Hide dotfolders" : "Show dotfolders"}
            </button>
          </div>
          <div className="list">
            {props.entries.map((e) => (
              <button className="listRow" key={e.path} onClick={() => e.kind === "dir" && props.onGo(e.path)}>
                <div className="listLeft">
                  <span className="chip">{e.kind}</span>
                  <div className="listText">
                    <div className="listTitle">{e.name}</div>
                    <div className="listSub mono">{e.path}</div>
                  </div>
                </div>
                <div className="listRight">{e.kind === "dir" ? ">" : ""}</div>
              </button>
            ))}
          </div>
          <div className="help">Dot-folders are hidden by default. Use the toggle above for `.worktrees`, `.git`, etc.</div>
        </div>
      </div>
    </div>
  );
}

