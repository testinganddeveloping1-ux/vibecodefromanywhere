import React from "react";
import type { ToolSessionMessage, ToolSessionMessageBlock, ToolSessionSummary } from "../types";
import { FencedMessage } from "../components/FencedMessage";

function renderBlock(block: ToolSessionMessageBlock, idx: number) {
  const key = `${block.type}-${block.callId ?? ""}-${idx}`;
  if (block.type === "thinking") {
    return (
      <details key={key} className="chatBlock chatBlockThinking">
        <summary className="chatBlockSummary mono">Thinking</summary>
        <div className="chatBlockBody">
          <FencedMessage text={block.text} />
        </div>
      </details>
    );
  }
  if (block.type === "tool_use") {
    return (
      <div key={key} className="chatBlock chatBlockToolUse">
        <div className="chatBlockHead mono">
          Tool call{block.name ? ` · ${block.name}` : ""}{block.callId ? ` · ${block.callId.slice(0, 10)}` : ""}
        </div>
        <div className="chatBlockBody">
          <FencedMessage text={block.text} />
        </div>
      </div>
    );
  }
  if (block.type === "tool_result") {
    return (
      <details key={key} className="chatBlock chatBlockToolResult">
        <summary className="chatBlockSummary mono">
          Tool result{block.callId ? ` · ${block.callId.slice(0, 10)}` : ""}
        </summary>
        <div className="chatBlockBody">
          <FencedMessage text={block.text} />
        </div>
      </details>
    );
  }
  return (
    <div key={key} className="chatBlock chatBlockText">
      <FencedMessage text={block.text} />
    </div>
  );
}

export function ToolChatModal(props: {
  open: boolean;
  session: ToolSessionSummary | null;
  messages: ToolSessionMessage[];
  loading: boolean;
  msg: string | null;
  limit: number;
  onClose: () => void;
  onOlder: () => void | Promise<void>;
  onAll: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
  onFork: () => void | Promise<void>;
}) {
  if (!props.open) return null;
  const s = props.session;
  const canLoadMore = Boolean(s) && props.messages.length >= props.limit && props.limit < 5000;
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modal modalChat">
        <div className="modalHead">
          <b>Chat History</b>
          {s ? <span className="chip chipOn">{s.tool}</span> : <span className="chip">loading</span>}
          {s?.id ? <span className="chip mono">{s.id.slice(0, 8)}</span> : null}
          <span className="chip mono">
            {props.messages.length}/{props.limit}
          </span>
          <div className="spacer" />
          {s ? (
            <>
              <button className="btn" onClick={props.onOlder} disabled={props.loading || !canLoadMore}>
                Older
              </button>
              <button className="btn ghost" onClick={props.onAll} disabled={props.loading || props.limit >= 5000 || props.messages.length < props.limit}>
                All
              </button>
              <button className="btn" onClick={props.onRefresh} disabled={props.loading}>
                Refresh
              </button>
              <button className="btn primary" onClick={props.onResume} disabled={props.loading}>
                Resume
              </button>
              <button className="btn ghost" onClick={props.onFork} disabled={props.loading}>
                Fork
              </button>
            </>
          ) : null}
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
        <div className="modalBody">
          {s?.cwd ? <div className="help mono">{s.cwd}</div> : null}
          {props.msg ? <div className="help mono">{props.msg}</div> : null}
          {props.loading ? <div className="help">Loading chat...</div> : null}
          {s && !props.loading ? (
            canLoadMore ? (
              <div className="help">Showing the last {props.messages.length} messages. Tap Older (or All) to load more.</div>
            ) : (
              <div className="help">Full chat history loaded for this session.</div>
            )
          ) : null}
          <div className="chatList">
            {props.messages.map((m, idx) => (
              <div key={idx} className={`chatMsg ${m.role === "user" ? "chatUser" : "chatAssistant"}`}>
                <div className="chatMeta mono">
                  {m.role} · {new Date(m.ts).toLocaleString()}
                </div>
                <div className="chatText">
                  {Array.isArray(m.blocks) && m.blocks.length > 0
                    ? m.blocks.map((b, bi) => renderBlock(b, bi))
                    : <FencedMessage text={m.text} />}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
