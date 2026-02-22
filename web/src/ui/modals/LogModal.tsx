import React from "react";
import type { EventItem } from "../types";
import { formatEventLine } from "../lib/text";
import { Modal, ModalHeader, ModalBody, ModalSpacer } from "../components/Modal";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";

export function LogModal(props: {
  open: boolean;
  events: EventItem[];
  onClose: () => void;
}) {
  const events = props.events ?? [];

  const fmtTime = (ts: number) => {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  return (
    <Modal open={props.open}>
      <ModalHeader>
        <b>Session Log</b>
        <Chip>{events.length}</Chip>
        <ModalSpacer />
        <Button onClick={props.onClose}>Close</Button>
      </ModalHeader>
      <ModalBody>
        <div className="list">
          {events.slice(-200).map((e) => (
            <div key={e.id} className="listRow" style={{ cursor: "default" }}>
              <div className="listLeft">
                <Chip>{e.kind}</Chip>
                <div className="listText">
                  <div className="listTitle mono">{formatEventLine(e).slice(0, 320)}</div>
                  <div className="listSub mono">{fmtTime(e.ts)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="help">
          This includes your inputs plus actions (interrupt/stop/kill) and approval decisions.
        </div>
      </ModalBody>
    </Modal>
  );
}
