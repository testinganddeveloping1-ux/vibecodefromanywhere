import React, { useMemo } from "react";

export function ModelPickerModal(props: {
  open: boolean;
  providers: string[];
  provider: string;
  query: string;
  models: string[];
  loading: boolean;
  msg: string | null;
  selectedModel: string;
  onClose: () => void;
  onProviderChange: (provider: string) => void;
  onQueryChange: (query: string) => void;
  onReload: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onClear: () => void;
  onSelect: (model: string) => void;
}) {
  const filtered = useMemo(() => {
    const prov = String(props.provider || "").trim();
    const q = String(props.query || "").trim().toLowerCase();
    let items = props.models ?? [];
    if (prov) items = items.filter((m) => String(m).startsWith(prov + "/"));
    if (q) items = items.filter((m) => String(m).toLowerCase().includes(q));
    return items;
  }, [props.models, props.provider, props.query]);

  if (!props.open) return null;
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modalHead">
          <b>OpenCode Models</b>
          <span className="chip mono">{(props.models ?? []).length}</span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
        <div className="modalBody">
          <div className="grid2">
            <div className="field">
              <label>Provider</label>
              <select value={props.provider} onChange={(e) => props.onProviderChange(e.target.value)}>
                <option value="">All providers</option>
                {props.providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Search</label>
              <input
                value={props.query}
                onChange={(e) => props.onQueryChange(e.target.value)}
                placeholder="glm, kimi, gpt-5, ... (filter)"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            <div className="runBtns span2" style={{ marginTop: 10 }}>
              <button className="btn" disabled={props.loading} onClick={props.onReload}>
                Reload
              </button>
              <button className="btn primary" disabled={props.loading} onClick={props.onRefresh}>
                Refresh
              </button>
              <button className="btn ghost" onClick={props.onClear}>
                Clear
              </button>
            </div>
          </div>
          {props.msg ? <div className="help mono">{props.msg}</div> : null}
          <div className="help">
            Model IDs are <span className="mono">provider/model</span>. If a provider needs credentials, configure it on the host (try{" "}
            <span className="mono">opencode auth</span>).
          </div>

          <div className="list">
            {filtered.slice(0, 240).map((m) => {
              const s = String(m);
              const idx = s.indexOf("/");
              const prov = idx > 0 ? s.slice(0, idx) : "model";
              const name = idx > 0 ? s.slice(idx + 1) : s;
              const selected = String(props.selectedModel || "").trim() === s;
              return (
                <button
                  className={`listRow ${selected ? "listRowOn" : ""}`}
                  key={s}
                  onClick={() => props.onSelect(s)}
                >
                  <div className="listLeft">
                    <span className={`chip ${selected ? "chipOn" : ""}`}>{prov}</span>
                    <div className="listText">
                      <div className="listTitle mono">{name}</div>
                      <div className="listSub mono">{s}</div>
                    </div>
                  </div>
                  <div className="listRight mono">{selected ? "selected" : ""}</div>
                </button>
              );
            })}
          </div>
          <div className="help mono">
            {filtered.length > 240 ? `Showing 240 of ${filtered.length}. Refine provider/search.` : `Showing ${filtered.length}.`}
          </div>
        </div>
      </div>
    </div>
  );
}

