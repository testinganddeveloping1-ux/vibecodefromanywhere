import React from "react";

export function ConfigModal(props: {
  open: boolean;
  toml: string;
  msg: string | null;
  onChange: (next: string) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  if (!props.open) return null;
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modalHead">
          <b>config.toml</b>
          <span className="chip">live profiles</span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
          <button className="btn primary" onClick={props.onSave}>
            Save
          </button>
        </div>
        <div className="modalBody">
          <textarea className="codebox" value={props.toml} onChange={(e) => props.onChange(e.target.value)} />
          <div className="help">{props.msg ? props.msg : "Tip: use tool-native fields, not startup macros."}</div>
        </div>
      </div>
    </div>
  );
}

