import React from "react";
import type { SessionRow } from "../types";
import { Modal, ModalHeader, ModalBody, ModalSpacer } from "../components/Modal";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";

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
  const s = props.activeSession;

  return (
    <Modal open={props.open}>
      <ModalHeader>
        <b>Controls</b>
        {s ? <Chip mono>{s.tool}</Chip> : null}
        <ModalSpacer />
        <Button onClick={props.onClose}>Close</Button>
      </ModalHeader>
      <ModalBody>
        <div className="row">
          <div className="cardTitle">Views</div>
          <div className="runBtns" style={{ marginTop: 10 }}>
            <Button onClick={props.onOpenLog}>Log</Button>
            <Button onClick={props.onOpenChat}>Chat</Button>
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
            <Button variant="primary" onClick={props.onSaveLabel}>
              Save
            </Button>
            <Button variant="ghost" onClick={props.onClearLabel}>
              Clear label
            </Button>
          </div>
          <div className="help">Labels show on pinned slots and in the Workspace list.</div>
        </div>

        <div className="row">
          <div className="cardTitle">Terminal</div>
          <div className="runBtns" style={{ marginTop: 10 }}>
            <Button variant="ghost" onClick={() => props.setFontSize((n) => Math.max(11, n - 1))}>
              A-
            </Button>
            <Button variant="ghost" onClick={() => props.setFontSize((n) => Math.min(22, n + 1))}>
              A+
            </Button>
            <Button onClick={props.onFit}>Fit</Button>
          </div>
          <div className="runBtns" style={{ marginTop: 10 }}>
            <Button
              variant={props.lineHeight < 1.5 ? "primary" : "ghost"}
              onClick={() => props.setLineHeight(1.45)}
            >
              Tight
            </Button>
            <Button
              variant={props.lineHeight >= 1.5 && props.lineHeight < 1.57 ? "primary" : "ghost"}
              onClick={() => props.setLineHeight(1.52)}
            >
              Normal
            </Button>
            <Button
              variant={props.lineHeight >= 1.57 ? "primary" : "ghost"}
              onClick={() => props.setLineHeight(1.6)}
            >
              Loose
            </Button>
          </div>
          <div className="runBtns" style={{ marginTop: 10 }}>
            <Button onClick={props.onCopy}>Copy</Button>
            <Button onClick={props.onPaste}>Paste</Button>
          </div>
          <div className="runBtns" style={{ marginTop: 10 }}>
            <Button onClick={() => props.onSendRaw("\u001b")}>Esc</Button>
            <Button onClick={() => props.onSendRaw("\t")}>Tab</Button>
            <Button onClick={() => props.onSendRaw("\u001b[Z")}>Shift+Tab</Button>
            <Button onClick={() => props.onSendRaw("\r")}>Enter</Button>
          </div>
          <div className="runBtns" style={{ marginTop: 10 }}>
            <Button onClick={() => props.onSendRaw("\u001b[D")}>Left</Button>
            <Button onClick={() => props.onSendRaw("\u001b[A")}>Up</Button>
            <Button onClick={() => props.onSendRaw("\u001b[B")}>Down</Button>
            <Button onClick={() => props.onSendRaw("\u001b[C")}>Right</Button>
          </div>
          <div className="help">Spacing can fix overlapping text on some mobile browsers.</div>
          <div className="help">
            Copy uses terminal selection. Paste reads from clipboard (works best on HTTPS or
            localhost).
          </div>
          <div className="help">Use these keys for TUI menus (permissions, mode picker, etc.).</div>
        </div>

        <div className="row">
          <div className="cardTitle">Process</div>
          <div className="runBtns" style={{ marginTop: 10 }}>
            <Button variant="danger" disabled={!s?.id} onClick={props.onRemoveSession}>
              Remove session
            </Button>
            <Button variant="danger" onClick={props.onKill}>
              Kill
            </Button>
          </div>
          <div className="help">
            Kill sends SIGKILL. Remove deletes this session and force-closes it first if still
            running.
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
}
