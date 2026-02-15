import React from "react";
import { FencedMessage } from "./FencedMessage";

export type CodexNativeBubble = {
  id: string;
  role: "user" | "assistant";
  kind: string;
  text: string;
};

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
    <div className="nativeChat" ref={props.innerRef ?? undefined}>
      <div className="nativeHead">
        <span className="chip chipOn">codex native</span>
        <span className="mono nativeMeta">{String(props.threadId ?? "").slice(0, 12)}</span>
        <div className="spacer" />
        {props.loading ? <span className="chip mono">loading</span> : null}
      </div>
      {props.error ? <div className="nativeError mono">{props.error}</div> : null}
      <div className="nativeMsgs">
        {props.messages.length === 0 && !props.live ? (
          <div className="nativeEmpty">
            <div className="help">No messages yet. Send something below.</div>
          </div>
        ) : null}
        {props.messages.map((m) => (
          <div key={m.id} className={`bubbleRow ${m.role === "user" ? "bubbleUser" : "bubbleAssistant"}`}>
            <div className="bubble">
              <div className="bubbleKind mono">{m.kind}</div>
              <FencedMessage text={m.text} />
            </div>
          </div>
        ))}
        {props.live ? (
          <div className="bubbleRow bubbleAssistant">
            <div className="bubble">
              <div className="bubbleKind mono">{props.live.kind}</div>
              <FencedMessage text={props.live.text} />
            </div>
          </div>
        ) : null}
        {props.diff ? (
          <details className="nativeDiff">
            <summary className="mono">Diff</summary>
            <pre className="mdCode">
              <code>{props.diff}</code>
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
