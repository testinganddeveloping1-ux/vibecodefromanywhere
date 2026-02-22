import React from "react";
import { Modal, ModalHeader, ModalBody, ModalSpacer } from "../components/Modal";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";

export function ConfigModal(props: {
  open: boolean;
  toml: string;
  msg: string | null;
  onChange: (next: string) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  return (
    <Modal open={props.open}>
      <ModalHeader>
        <b>config.toml</b>
        <Chip>live profiles</Chip>
        <ModalSpacer />
        <Button onClick={props.onClose}>Close</Button>
        <Button variant="primary" onClick={props.onSave}>
          Save
        </Button>
      </ModalHeader>
      <ModalBody>
        <textarea className="codebox" value={props.toml} onChange={(e) => props.onChange(e.target.value)} />
        <div className="help">{props.msg ? props.msg : "Tip: use tool-native fields, not startup macros."}</div>
      </ModalBody>
    </Modal>
  );
}
