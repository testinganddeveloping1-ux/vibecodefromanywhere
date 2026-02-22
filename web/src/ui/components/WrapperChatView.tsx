import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ToolSessionMessage, ToolSessionSummary } from "../types";
import { FencedMessage } from "./FencedMessage";
import styles from "./WrapperChatView.module.css";
import {
  buildTimeline,
  clamp,
  countResultLines,
  fmt,
  looksLikeToolLogText,
  orchestrationActionTitle,
  renderInlinePreview,
  shortCallId,
  TOOL_COLOR,
  TOOL_ICON,
  TOOL_LABEL,
  TYPING_STALE_MS,
  TYPING_STALE_SECONDS,
  type ToolResultItem,
  type ToolState,
  type ToolUseItem,
  type ViewMode,
} from "../lib/timeline";

// ─── Component ────────────────────────────────────────────────────────────────

export function WrapperChatView(props: {
  session: ToolSessionSummary | null;
  messages: ToolSessionMessage[];
  loading: boolean;
  msg: string | null;
  running: boolean;
  formatPath?: (path: string) => string;
  onRefresh: () => void;
  onHistory: () => void;
}) {
  const [mode, setMode] = useState<ViewMode>("focus");
  const [nowTs, setNowTs] = useState(() => Date.now());
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  const timeline = useMemo(() => buildTimeline(props.messages), [props.messages]);

  const toolStateByCall = useMemo(() => {
    const m = new Map<string, ToolState>();
    for (const item of timeline) {
      if (item.kind === "tool_use" && item.callId) m.set(item.callId, "running");
      if (item.kind === "tool_result" && item.callId) m.set(item.callId, item.state);
    }
    return m;
  }, [timeline]);

  const pairedToolResults = useMemo(() => {
    const useToResult = new Map<string, ToolResultItem>();
    const pairedResultIds = new Set<string>();
    const activeByCallId = new Map<string, string>();
    const pendingAnon: string[] = [];

    for (const item of timeline) {
      if (item.kind === "tool_use") {
        if (item.callId) activeByCallId.set(item.callId, item.id);
        else pendingAnon.push(item.id);
        continue;
      }
      if (item.kind !== "tool_result") continue;

      let useId: string | undefined;
      if (item.callId) useId = activeByCallId.get(item.callId);
      if (!useId && pendingAnon.length > 0) useId = pendingAnon[pendingAnon.length - 1];
      if (!useId) continue;

      useToResult.set(useId, item);
      pairedResultIds.add(item.id);
      if (!item.callId && pendingAnon[pendingAnon.length - 1] === useId) pendingAnon.pop();
    }

    return { useToResult, pairedResultIds };
  }, [timeline]);

  const resolveToolState = (item: ToolUseItem): ToolState => {
    const paired = pairedToolResults.useToResult.get(item.id);
    if (paired) return paired.state;
    if (item.callId) return toolStateByCall.get(item.callId) ?? "running";
    return "running";
  };

  const lastThinkingSeq = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i]!.kind === "thinking") return timeline[i]!.seq;
    }
    return -1;
  }, [timeline]);

  const stats = useMemo(() => {
    let total = 0, running = 0, errors = 0;
    for (const item of timeline) {
      if (item.kind !== "tool_use") continue;
      total++;
      const s = resolveToolState(item);
      if (s === "running") running++;
      if (s === "error") errors++;
    }
    return { total, running, errors };
  }, [timeline, pairedToolResults.useToResult, toolStateByCall]);

  const sessionBadge = useMemo(() => {
    const tool = String(props.session?.tool ?? "").trim().toUpperCase();
    if (!tool) return "";
    const id = String(props.session?.id ?? "").trim();
    if (!id) return tool;
    const short = id.length > 8 ? `${id.slice(0, 8)}…` : id;
    return `${tool} #${short}`;
  }, [props.session?.tool, props.session?.id]);

  const lastUserSeq = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i]!.kind === "user") return timeline[i]!.seq;
    }
    return -1;
  }, [timeline]);

  const lastAssistantSeq = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i]!.kind === "assistant") return timeline[i]!.seq;
    }
    return -1;
  }, [timeline]);

  const latestNonSystem = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i]!.kind !== "system") return timeline[i]!;
    }
    return null;
  }, [timeline]);

  const hasPendingToolUse = useMemo(
    () => timeline.some((item) => item.kind === "tool_use" && !pairedToolResults.useToResult.has(item.id)),
    [timeline, pairedToolResults.useToResult],
  );

  const showTypingBubble = useMemo(() => {
    if (!props.running) return false;
    if (!latestNonSystem) return true;
    if (latestNonSystem.kind === "assistant" && !hasPendingToolUse) return false;
    if (lastUserSeq > lastAssistantSeq) return true;
    if (latestNonSystem.kind === "thinking") return true;
    if (latestNonSystem.kind === "tool_use") return true;
    if (hasPendingToolUse) return true;
    return false;
  }, [props.running, latestNonSystem, hasPendingToolUse, lastUserSeq, lastAssistantSeq]);

  const typingStale = useMemo(() => {
    if (!showTypingBubble || !props.running) return false;
    const latestTs = Number(latestNonSystem?.ts ?? 0);
    if (!Number.isFinite(latestTs) || latestTs <= 0) return false;
    return nowTs - latestTs >= TYPING_STALE_MS;
  }, [showTypingBubble, props.running, latestNonSystem?.ts, nowTs]);

  const visible = useMemo(() => {
    if (mode === "tools") {
      return timeline
        .filter((x) => x.kind === "tool_use" || (x.kind === "tool_result" && !pairedToolResults.pairedResultIds.has(x.id)))
        .slice(-60);
    }
    if (mode === "all") return timeline.slice(-100);
    const nonSystem = timeline.filter((x) => x.kind !== "system");
    const recentTools = nonSystem
      .filter((x) => {
        if (x.kind === "tool_result" && pairedToolResults.pairedResultIds.has(x.id)) return false;
        return x.kind !== "user" && x.kind !== "assistant";
      })
      .slice(-15);
    const allUser = nonSystem.filter((x) => x.kind === "user").slice(-8);
    const recentAssistant = nonSystem
      .filter((x) => x.kind === "assistant" && !looksLikeToolLogText(x.text))
      .slice(-5);
    const merged = [...allUser, ...recentTools, ...recentAssistant];
    const seen = new Set<string>();
    const deduped = merged.filter((x) => { if (seen.has(x.id)) return false; seen.add(x.id); return true; });
    return deduped.sort((a, b) => a.seq - b.seq);
  }, [mode, timeline, pairedToolResults.pairedResultIds]);

  const latestVisibleId = visible.length > 0 ? visible[visible.length - 1]!.id : "";

  useEffect(() => {
    if (timeline.length !== prevLenRef.current) {
      prevLenRef.current = timeline.length;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [timeline.length]);

  useEffect(() => {
    if (!props.running) return;
    const tm = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(tm);
  }, [props.running]);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [mode, latestVisibleId, showTypingBubble]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.chat}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <div className={styles.modes}>
            {(["focus", "tools", "all"] as ViewMode[]).map((m) => (
              <button
                key={m}
                className={`${styles.modeBtn} ${mode === m ? styles.modeBtnOn : ""}`}
                onClick={() => setMode(m)}
              >
                {m === "focus" ? "Focus" : m === "tools" ? "Tools" : "Timeline"}
              </button>
            ))}
          </div>
          {sessionBadge && <span className={`${styles.sessionBadge} ${styles.mono}`}>{sessionBadge}</span>}
        </div>
        <div className={styles.toolbarRight}>
          <div className={styles.stats}>
            <span className={`${styles.stat} ${styles.mono}`}>{stats.total} calls</span>
            <span className={`${styles.stat} ${styles.mono} ${stats.running > 0 ? styles.statOn : ""}`}>
              {stats.running} live
            </span>
            {stats.errors > 0 ? (
              <span className={`${styles.stat} ${styles.statErr} ${styles.mono}`}>{stats.errors} err</span>
            ) : null}
          </div>
          <button
            className={styles.refreshBtn}
            onClick={props.onRefresh}
            disabled={props.loading}
            aria-label="Refresh"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>
      </div>

      {props.session?.cwd && (
        <div className={`${styles.cwd} ${styles.mono}`}>
          {props.formatPath ? props.formatPath(props.session.cwd) : props.session.cwd}
        </div>
      )}
      {props.msg && <div className={styles.error}>{props.msg}</div>}

      {/* Timeline feed */}
      <div className={styles.feed}>
        {visible.length === 0 && (
          <div className={styles.empty}>
            {props.loading ? (
              <>
                <div className={styles.loadingDots}>
                  <span />
                  <span />
                  <span />
                </div>
                <span className={styles.dimText}>Loading…</span>
              </>
            ) : (
              <span className={styles.dimText}>No messages in this view.</span>
            )}
          </div>
        )}

        {visible.map((item) => {
          // System events
          if (item.kind === "system") {
            if (mode === "focus") return null;
            return (
              <div key={item.id} className={styles.sysEvent}>
                <span>{clamp(item.text, 50)}</span>
              </div>
            );
          }

          // User message
          if (item.kind === "user") {
            return (
              <div key={item.id} className={`${styles.msg} ${styles.msgUser}`}>
                <div className={`${styles.msgBubble} ${styles.msgBubbleUser}`}>
                  <div className={styles.msgText}>{item.text}</div>
                  <div className={styles.msgTime}>{fmt(item.ts)}</div>
                </div>
              </div>
            );
          }

          // Assistant message
          if (item.kind === "assistant") {
            return (
              <div key={item.id} className={`${styles.msg} ${styles.msgAssistant}`}>
                <div className={styles.msgBubble}>
                  <FencedMessage text={item.text} />
                  <div className={styles.msgTime}>{fmt(item.ts)}</div>
                </div>
              </div>
            );
          }

          // Thinking block
          if (item.kind === "thinking") {
            const isLive = props.running && item.seq === lastThinkingSeq;
            const preview = clamp(item.text, 120);
            const headContent = (
              <>
                <div className={styles.thinkHeadLeft}>
                  <span className={styles.thinkLabel}>
                    Thinking
                    {isLive && <span className={styles.liveDot} />}
                  </span>
                  <span className={styles.thinkPreview}>
                    {renderInlinePreview(preview, `${item.id}-preview`)}
                  </span>
                </div>
                <span className={styles.msgTime}>{fmt(item.ts)}</span>
              </>
            );
            const body = (
              <div className={styles.thinkBody}>
                <FencedMessage text={item.text} />
              </div>
            );
            if (mode !== "all") {
              return (
                <div key={item.id} className={`${styles.think} ${isLive ? styles.thinkLive : ""}`}>
                  <div className={`${styles.thinkHead} ${styles.thinkHeadStatic}`}>{headContent}</div>
                  {body}
                </div>
              );
            }
            return (
              <details key={item.id} className={`${styles.think} ${isLive ? styles.thinkLive : ""}`} open={isLive}>
                <summary className={styles.thinkHead}>{headContent}</summary>
                {body}
              </details>
            );
          }

          // Tool use
          if (item.kind === "tool_use") {
            const pairedResult = pairedToolResults.useToResult.get(item.id);
            const state = resolveToolState(item);
            const color = TOOL_COLOR[item.toolKind];
            const label = TOOL_LABEL[item.toolKind];
            const callLabel = shortCallId(item.callId);
            const shouldOpen = state === "running" || state === "warn" || state === "error";
            const orchMeta = item.toolKind === "orch" ? (item.orchMeta ?? null) : null;
            const summaryText = orchMeta
              ? orchestrationActionTitle(orchMeta)
              : item.toolKind === "bash" && item.command
                ? item.command
                : item.fields[0]?.value
                  ? item.fields[0].value
                  : item.summary;
            const resultLineCount = pairedResult ? countResultLines(pairedResult.text) : 0;
            const showPayload = Boolean(item.inputText.trim());
            const showFullOutput = Boolean(pairedResult && !pairedResult.isEmpty && pairedResult.text !== pairedResult.preview);

            const headContent = (
              <>
                <div className={styles.toolHeadLeft}>
                  <span className={styles.toolIcon}>{TOOL_ICON[item.toolKind]}</span>
                  <div className={styles.toolMain}>
                    <div className={styles.toolTop}>
                      <span className={styles.toolLabel}>{label}</span>
                      <span className={`${styles.toolName} ${styles.mono}`}>{item.name || "tool"}</span>
                      {callLabel && <span className={`${styles.toolCallId} ${styles.mono}`}>#{callLabel}</span>}
                    </div>
                    <span className={`${styles.toolCmd} ${styles.mono}`}>{clamp(summaryText, 132)}</span>
                  </div>
                </div>
                <div className={styles.toolHeadRight}>
                  {state === "running" && <span className={styles.liveDot} />}
                  <span className={`${styles.toolStateBadge} ${styles["toolStateBadge--" + state]}`}>{state}</span>
                </div>
              </>
            );

            const body = (
              <div className={styles.toolBody}>
                {orchMeta ? (
                  <div className={styles.orchCmdCard}>
                    <div className={styles.orchCmdTitle}>{orchestrationActionTitle(orchMeta)}</div>
                    <div className={styles.orchCmdMetaRow}>
                      <span className={`${styles.orchCmdChip} ${styles.mono}`}>{orchMeta.method}</span>
                      <span className={`${styles.orchCmdPath} ${styles.mono}`}>{orchMeta.endpoint}</span>
                    </div>
                    {orchMeta.orchestrationId && <div className={styles.orchCmdLine}><span className={styles.mono}>orchestration</span>: <span className={styles.mono}>{orchMeta.orchestrationId}</span></div>}
                    {orchMeta.sessionId && <div className={styles.orchCmdLine}><span className={styles.mono}>session</span>: <span className={styles.mono}>{orchMeta.sessionId}</span></div>}
                    {/* Additional orchMeta lines continue seamlessly mapping to CSS module classes */}
                  </div>
                ) : item.toolKind === "bash" && item.command ? (
                  <div className={styles.bashBlock}>
                    <span className={styles.bashPrompt}>$</span>
                    <span className={styles.mono}>{item.command}</span>
                  </div>
                ) : null}

                {!orchMeta && item.toolKind !== "bash" && (
                  <div className={`${styles.toolSummaryText} ${styles.mono}`}>{item.summary}</div>
                )}
                {!orchMeta &&
                  item.fields.map((f, i) => (
                    <div key={i} className={styles.toolField}>
                      <span className={`${styles.toolFieldKey} ${styles.mono}`}>{f.key}</span>
                      <span className={`${styles.toolFieldVal} ${styles.mono}`}>{f.value}</span>
                    </div>
                  ))}

                <div className={`${styles.inlineResult} ${styles["inlineResult--" + state]}`}>
                  {pairedResult ? (
                    <>
                      <div className={styles.inlineResultHead}>
                        <span className={styles.inlineResultLabel}>
                          {pairedResult.isEmpty ? "No output" : "Result"}
                        </span>
                        <span className={`${styles.inlineResultMeta} ${styles.mono}`}>
                          {Math.max(1, resultLineCount)} lines
                        </span>
                      </div>
                      <pre className={`${styles.inlineResultText} ${styles.mono}`}>{pairedResult.preview}</pre>
                      {showFullOutput && (
                        <details className={styles.raw}>
                          <summary className={`${styles.rawSummary} ${styles.mono}`}>Full output</summary>
                          <FencedMessage text={pairedResult.text} />
                        </details>
                      )}
                    </>
                  ) : (
                    <div className={styles.inlinePending}>
                      <span className={styles.liveDot} />
                      <span className={styles.mono}>Waiting for output…</span>
                    </div>
                  )}
                </div>

                {showPayload && (
                  <details className={styles.raw}>
                    <summary className={`${styles.rawSummary} ${styles.mono}`}>Raw payload</summary>
                    <FencedMessage text={item.inputText} />
                  </details>
                )}
              </div>
            );

            return (
              <details
                key={item.id}
                className={`${styles.tool} ${styles.toolStateCard} ${styles["toolStateCard--" + state]}`}
                style={{ "--tool-color": color } as React.CSSProperties}
                open={shouldOpen ? true : undefined}
              >
                <summary className={styles.toolHead}>{headContent}</summary>
                {body}
              </details>
            );
          }

          // Unpaired tool result
          if (item.kind === "tool_result") {
            if (pairedToolResults.pairedResultIds.has(item.id)) return null;
            const needsExpand = item.text !== item.preview;
            const callLabel = shortCallId(item.callId);
            const shouldOpen = item.state === "running" || item.state === "warn" || item.state === "error";
            const headContent = (
              <>
                <div className={styles.toolHeadLeft}>
                  <span className={`${styles.toolIcon} ${styles.dimText}`}>{TOOL_ICON.result}</span>
                  <span className={styles.resultLabel}>{item.isEmpty ? "No output" : "Result"}</span>
                  {callLabel && <span className={`${styles.toolCallId} ${styles.mono}`}>#{callLabel}</span>}
                  <span className={`${styles.resultPreview} ${styles.mono}`}>{item.preview}</span>
                </div>
                <span className={`${styles.toolStateBadge} ${styles["toolStateBadge--" + item.state]}`}>{item.state}</span>
              </>
            );
            const body = (
              <div className={styles.resultBody}>
                <pre className={`${styles.resultText} ${styles.mono}`}>{item.preview}</pre>
                {needsExpand && !item.isEmpty && (
                  <details className={styles.raw}>
                    <summary className={`${styles.rawSummary} ${styles.mono}`}>Full output</summary>
                    <FencedMessage text={item.text} />
                  </details>
                )}
              </div>
            );
            return (
              <details
                key={item.id}
                className={`${styles.result} ${styles["result--" + item.state]}`}
                open={shouldOpen ? true : undefined}
              >
                <summary className={styles.toolHead}>{headContent}</summary>
                {body}
              </details>
            );
          }

          return null;
        })}

        {showTypingBubble ? (
          <div className={`${styles.msg} ${styles.msgAssistant} ${styles.typingRow}`}>
            <div
              className={`${styles.msgBubble} ${styles.typingBubble} ${typingStale ? styles.typingBubbleStale : ""}`}
              role="status"
              aria-live="polite"
              aria-label={
                typingStale
                  ? `No updates for ${TYPING_STALE_SECONDS} seconds. Waiting for input or completion.`
                  : "Assistant is processing"
              }
            >
              {typingStale ? (
                <span className={`${styles.typingHint} ${styles.mono}`}>
                  {`No updates for ${TYPING_STALE_SECONDS}s - waiting input/done`}
                </span>
              ) : (
                <span className={styles.typingDots} aria-hidden="true">
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                </span>
              )}
            </div>
          </div>
        ) : null}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
