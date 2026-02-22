import React from "react";
import type { ToolSessionMessage, ToolSessionMessageBlock, ToolSessionSummary } from "../types";
import { FencedMessage } from "../components/FencedMessage";
import { Modal, ModalHeader, ModalBody, ModalSpacer } from "../components/Modal";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import styles from "./ToolChatModal.module.css";

function renderBlock(block: ToolSessionMessageBlock, idx: number) {
  const key = `${block.type}-${block.callId ?? ""}-${idx}`;

  if (block.type === "thinking") {
    return (
      <details key={key} className={[styles.chatBlock, styles.chatBlockThinking].join(" ")}>
        <summary className={styles.chatBlockSummary}>Thinking</summary>
        <div className={styles.chatBlockBody}>
          <FencedMessage text={block.text} />
        </div>
      </details>
    );
  }

  if (block.type === "tool_use") {
    return (
      <div key={key} className={[styles.chatBlock, styles.chatBlockToolUse].join(" ")}>
        <div className={styles.chatBlockHead}>
          Tool call{block.name ? ` · ${block.name}` : ""}
          {block.callId ? ` · ${block.callId.slice(0, 10)}` : ""}
        </div>
        <div className={styles.chatBlockBody}>
          <FencedMessage text={block.text} />
        </div>
      </div>
    );
  }

  if (block.type === "tool_result") {
    return (
      <details key={key} className={[styles.chatBlock, styles.chatBlockToolResult].join(" ")}>
        <summary className={styles.chatBlockSummary}>
          Tool result{block.callId ? ` · ${block.callId.slice(0, 10)}` : ""}
        </summary>
        <div className={styles.chatBlockBody}>
          <FencedMessage text={block.text} />
        </div>
      </details>
    );
  }

  return (
    <div key={key} className={[styles.chatBlock, styles.chatBlockText].join(" ")}>
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
  formatPath?: (path: string) => string;
  limit: number;
  onClose: () => void;
  onOlder: () => void | Promise<void>;
  onAll: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
  onFork: () => void | Promise<void>;
}) {
  const s = props.session;
  const canLoadMore = Boolean(s) && props.messages.length >= props.limit && props.limit < 5000;

  const fmtTime = (ts: number) => {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  return (
    <Modal open={props.open} wide>
      <ModalHeader>
        <b>Chat History</b>
        {s ? <Chip active>{s.tool}</Chip> : <Chip>loading</Chip>}
        {s?.id ? <Chip mono>{s.id.slice(0, 8)}</Chip> : null}
        <Chip mono>
          {props.messages.length}/{props.limit}
        </Chip>
        <ModalSpacer />
        {s ? (
          <>
            <Button onClick={props.onOlder} disabled={props.loading || !canLoadMore}>
              Older
            </Button>
            <Button
              variant="ghost"
              onClick={props.onAll}
              disabled={props.loading || props.limit >= 5000 || props.messages.length < props.limit}
            >
              All
            </Button>
            <Button onClick={props.onRefresh} disabled={props.loading}>
              Refresh
            </Button>
            <Button variant="primary" onClick={props.onResume} disabled={props.loading}>
              Resume
            </Button>
            <Button variant="ghost" onClick={props.onFork} disabled={props.loading}>
              Fork
            </Button>
          </>
        ) : null}
        <Button onClick={props.onClose}>Close</Button>
      </ModalHeader>
      <ModalBody>
        {s?.cwd ? (
          <div className="help mono">
            {props.formatPath ? props.formatPath(s.cwd) : s.cwd}
          </div>
        ) : null}
        {props.msg ? <div className="help mono">{props.msg}</div> : null}
        {props.loading ? <div className="help">Loading chat...</div> : null}
        {s && !props.loading ? (
          canLoadMore ? (
            <div className="help">
              Showing the last {props.messages.length} messages. Tap Older (or All) to load more.
            </div>
          ) : (
            <div className="help">Full chat history loaded for this session.</div>
          )
        ) : null}
        <div className={styles.chatList}>
          {props.messages.map((m, idx) => (
            <div
              key={idx}
              className={[
                styles.chatMsg,
                m.role === "user" ? styles.chatUser : styles.chatAssistant,
              ].join(" ")}
            >
              <div className={styles.chatMeta}>
                {m.role} · {fmtTime(m.ts)}
              </div>
              <div className={styles.chatText}>
                {Array.isArray(m.blocks) && m.blocks.length > 0
                  ? m.blocks.map((b, bi) => renderBlock(b, bi))
                  : <FencedMessage text={m.text} />}
              </div>
            </div>
          ))}
        </div>
      </ModalBody>
    </Modal>
  );
}
