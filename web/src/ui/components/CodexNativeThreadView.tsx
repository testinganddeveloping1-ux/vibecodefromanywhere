import React from "react";
import { FencedMessage } from "./FencedMessage";
import { Chip } from "./Chip";
import styles from "./CodexNativeThreadView.module.css";

export type CodexNativeBubble = {
  id: string;
  role: "user" | "assistant";
  kind: string;
  text: string;
  tone?: "default" | "thinking" | "toolUse" | "toolResult";
};

function kindLabel(kind: string): string {
  const k = String(kind || "").trim().toLowerCase();
  if (k === "tool_use") return "tool call";
  if (k === "tool_result") return "tool result";
  if (k === "thinking") return "thinking";
  return kind || "message";
}

export function CodexNativeThreadView(props: {
  threadId: string;
  loading: boolean;
  error: string | null;
  messages: CodexNativeBubble[];
  live: { kind: string; text: string } | null;
  diff: string | null;
  innerRef?: React.RefObject<HTMLDivElement> | null;
}) {
  return (
    <div className={styles.chat} ref={props.innerRef ?? undefined}>
      <div className={styles.head}>
        <Chip active>codex native</Chip>
        <span className={styles.meta}>{String(props.threadId ?? "").slice(0, 12)}</span>
        <div className={styles.spacer} />
        {props.loading ? <Chip mono>loading</Chip> : null}
      </div>
      {props.error ? <div className={styles.error}>{props.error}</div> : null}
      <div className={styles.msgs}>
        {props.messages.length === 0 && !props.live ? (
          <div className={styles.empty}>No messages yet. Send something below.</div>
        ) : null}
        {props.messages.map((m) => {
          const bubbleCls = [
            styles.bubble,
            m.tone === "thinking" ? styles.bubbleThinking : null,
            m.tone === "toolUse" ? styles.bubbleToolUse : null,
            m.tone === "toolResult" ? styles.bubbleToolResult : null,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={m.id}
              className={[
                styles.bubbleRow,
                m.role === "user" ? styles.bubbleUser : styles.bubbleAssistant,
              ].join(" ")}
            >
              <div className={bubbleCls}>
                <div className={styles.bubbleKind}>{kindLabel(m.kind)}</div>
                <FencedMessage text={m.text} />
              </div>
            </div>
          );
        })}
        {props.live ? (
          <div className={[styles.bubbleRow, styles.bubbleAssistant].join(" ")}>
            <div className={styles.bubble}>
              <div className={styles.bubbleKind}>{props.live.kind}</div>
              <FencedMessage text={props.live.text} />
            </div>
          </div>
        ) : null}
        {props.diff ? (
          <details className={styles.diff}>
            <summary>Diff</summary>
            <pre className="mdCode">
              <code>{props.diff}</code>
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
