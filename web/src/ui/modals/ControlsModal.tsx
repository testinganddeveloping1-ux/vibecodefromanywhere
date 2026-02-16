import React from "react";
import type { SessionRow } from "../types";

export function ControlsModal(props: {
  open: boolean;
  activeSession: SessionRow | null;
  labelDraft: string;
  setLabelDraft: (v: string) => void;
  fontSize: number;
  setFontSize: (updater: (n: number) => number) => void;
  lineHeight: number;
  setLineHeight: (v: number) => void;
  onClose: () => void;
  onOpenLog: () => void;
  onOpenChat: () => void;
  onSaveLabel: () => void | Promise<void>;
  onClearLabel: () => void;
  onFit: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSendRaw: (seq: string) => void;
  onRemoveSession: () => void;
  onKill: () => void;
}) {
  if (!props.open) return null;
  const s = props.activeSession;
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modalHead">
          <b>Controls</b>
          {s ? <span className="chip mono">{s.tool}</span> : null}
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
        <div className="modalBody">
          <div className="row">
            <div className="cardTitle">Views</div>
            <div className="runBtns" style={{ marginTop: 10 }}>
              <button className="btn" onClick={props.onOpenLog}>
                Log
              </button>
              <button className="btn" onClick={props.onOpenChat}>
                Chat
              </button>
            </div>
            <div className="help">Tool-native chat history is stored by Codex/Claude on this host.</div>
          </div>

          <div className="row">
            <div className="cardTitle">Session</div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Label</label>
              <input
                value={props.labelDraft}
                onChange={(e) => props.setLabelDraft(e.target.value)}
                placeholder="optional name (e.g. api-fix, auth, ui)"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            <div className="runBtns" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={props.onSaveLabel}>
                Save
              </button>
              <button className="btn ghost" onClick={props.onClearLabel}>
                Clear label
              </button>
            </div>
            <div className="help">Labels show on pinned slots and in the Workspace list.</div>
          </div>

          <div className="row">
            <div className="cardTitle">Terminal</div>
            <div className="runBtns" style={{ marginTop: 10 }}>
              <button className="btn ghost" onClick={() => props.setFontSize((n) => Math.max(11, n - 1))}>
                A-
              </button>
              <button className="btn ghost" onClick={() => props.setFontSize((n) => Math.min(22, n + 1))}>
                A+
              </button>
              <button className="btn" onClick={props.onFit}>
                Fit
              </button>
            </div>
            <div className="runBtns" style={{ marginTop: 10 }}>
              <button className={`btn ${props.lineHeight < 1.5 ? "primary" : "ghost"}`} onClick={() => props.setLineHeight(1.45)}>
                Tight
              </button>
              <button
                className={`btn ${props.lineHeight >= 1.5 && props.lineHeight < 1.57 ? "primary" : "ghost"}`}
                onClick={() => props.setLineHeight(1.52)}
              >
                Normal
              </button>
              <button className={`btn ${props.lineHeight >= 1.57 ? "primary" : "ghost"}`} onClick={() => props.setLineHeight(1.6)}>
                Loose
              </button>
            </div>
            <div className="runBtns" style={{ marginTop: 10 }}>
              <button className="btn" onClick={props.onCopy}>
                Copy
              </button>
              <button className="btn" onClick={props.onPaste}>
                Paste
              </button>
            </div>
            <div className="runBtns" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => props.onSendRaw("\u001b")}>
                Esc
              </button>
              <button className="btn" onClick={() => props.onSendRaw("\t")}>
                Tab
              </button>
              <button className="btn" onClick={() => props.onSendRaw("\u001b[Z")}>
                Shift+Tab
              </button>
              <button className="btn" onClick={() => props.onSendRaw("\r")}>
                Enter
              </button>
            </div>
            <div className="runBtns" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => props.onSendRaw("\u001b[D")}>
                Left
              </button>
              <button className="btn" onClick={() => props.onSendRaw("\u001b[A")}>
                Up
              </button>
              <button className="btn" onClick={() => props.onSendRaw("\u001b[B")}>
                Down
              </button>
              <button className="btn" onClick={() => props.onSendRaw("\u001b[C")}>
                Right
              </button>
            </div>
            <div className="help">Spacing can fix overlapping text on some mobile browsers.</div>
            <div className="help">Copy uses terminal selection. Paste reads from clipboard (works best on HTTPS or localhost).</div>
            <div className="help">Use these keys for TUI menus (permissions, mode picker, etc.).</div>
          </div>

          <div className="row">
            <div className="cardTitle">Process</div>
            <div className="runBtns" style={{ marginTop: 10 }}>
              <button className="btn danger" disabled={!s?.id} onClick={props.onRemoveSession}>
                Remove session
              </button>
              <button className="btn danger" onClick={props.onKill}>
                Kill
              </button>
            </div>
            <div className="help">Kill sends SIGKILL. Remove deletes this session and force-closes it first if still running.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
