import type { ReactNode } from "react";
import styles from "./FencedMessage.module.css";

type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; code: string };

function splitFenced(raw: string): Segment[] {
  const parts = raw.split("```");
  if (parts.length <= 1) return [{ kind: "text", text: raw }];
  const out: Segment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    const isCode = i % 2 === 1;
    if (!isCode) {
      if (part) out.push({ kind: "text", text: part });
      continue;
    }
    const idx = part.indexOf("\n");
    const lang = idx >= 0 ? part.slice(0, idx).trim() : "";
    const code = (idx >= 0 ? part.slice(idx + 1) : part).replace(/\n$/, "");
    out.push({ kind: "code", lang, code });
  }
  return out;
}

function isRuleLine(line: string): boolean {
  const t = String(line ?? "").trim();
  if (t.length < 3) return false;
  if (/[A-Za-z0-9]/.test(t)) return false;
  return /^[-_=~\u2500-\u259F\u23af\u2010-\u2015]+$/u.test(t);
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let idx = 0;
  let m: RegExpExecArray | null;
  let part = 0;
  while ((m = re.exec(text))) {
    const start = m.index;
    const token = m[0] ?? "";
    if (start > idx) out.push(text.slice(idx, start));
    if (token.startsWith("`")) {
      out.push(
        <code key={`${keyBase}-c-${part}`} className={styles.inlineCode}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={`${keyBase}-b-${part}`} className={styles.strong}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(
        <em key={`${keyBase}-i-${part}`} className={styles.em}>
          {token.slice(1, -1)}
        </em>,
      );
    }
    idx = start + token.length;
    part += 1;
  }
  if (idx < text.length) out.push(text.slice(idx));
  return out.length ? out : [text];
}

function renderText(text: string, keyBase: string): ReactNode[] {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const out: ReactNode[] = [];
  blocks.forEach((rawBlock, i) => {
    const block = rawBlock.trimEnd();
    if (!block.trim()) return;
    const lines = block.split("\n");
    const first = lines[0]?.trim() ?? "";
    const k = `${keyBase}-${i}`;

    const heading = /^(#{1,6})\s+(.*)$/.exec(first);
    if (heading && lines.length === 1) {
      const level = Math.min(6, Math.max(1, heading[1]?.length ?? 1));
      const content = heading[2] ?? "";

      const headerMap: Record<number, string> = {
        1: styles.h1, 2: styles.h2, 3: styles.h3,
        4: styles.h4, 5: styles.h5, 6: styles.h6
      };

      const cls = headerMap[level] || styles.h6;
      out.push(
        <div key={k} className={cls}>
          {renderInline(content, `${k}-h`)}
        </div>,
      );
      return;
    }

    const isQuote = lines.every((ln) => /^\s*>\s?/.test(ln));
    if (isQuote) {
      out.push(
        <blockquote key={k} className={styles.quote}>
          {lines.map((ln, li) => (
            <span key={`${k}-q-${li}`}>
              {renderInline(ln.replace(/^\s*>\s?/, ""), `${k}-q-${li}`)}
              {li < lines.length - 1 ? <br /> : null}
            </span>
          ))}
        </blockquote>,
      );
      return;
    }

    const isUl = lines.every((ln) => /^\s*[-*+]\s+/.test(ln));
    if (isUl) {
      out.push(
        <ul key={k} className={styles.ul}>
          {lines.map((ln, li) => (
            <li key={`${k}-ul-${li}`} className={styles.li}>
              {renderInline(ln.replace(/^\s*[-*+]\s+/, ""), `${k}-ul-${li}`)}
            </li>
          ))}
        </ul>,
      );
      return;
    }

    const isOl = lines.every((ln) => /^\s*\d+\.\s+/.test(ln));
    if (isOl) {
      out.push(
        <ol key={k} className={styles.ol}>
          {lines.map((ln, li) => (
            <li key={`${k}-ol-${li}`} className={styles.li}>
              {renderInline(ln.replace(/^\s*\d+\.\s+/, ""), `${k}-ol-${li}`)}
            </li>
          ))}
        </ol>,
      );
      return;
    }

    const isHr = lines.length === 1 && isRuleLine(first);
    if (isHr) {
      return;
    }

    out.push(
      <p key={k} className={styles.p}>
        {lines.map((ln, li) => (
          <span key={`${k}-p-${li}`}>
            {renderInline(ln, `${k}-p-${li}`)}
            {li < lines.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>,
    );
  });
  if (out.length > 0) return out;
  const onlyRules = blocks.every((block) => {
    const lines = block.split("\n").map((ln) => ln.trim()).filter(Boolean);
    return lines.length > 0 && lines.every((ln) => isRuleLine(ln));
  });
  if (onlyRules) return [];
  return [<div key={`${keyBase}-empty`} className={styles.text}>{text}</div>];
}

export function FencedMessage({ text }: { text: string }) {
  const raw = String(text ?? "");
  const segments = splitFenced(raw);
  return (
    <div className={styles.md}>
      {segments.map((seg, i) => {
        if (seg.kind === "code") {
          return (
            <pre key={`code-${i}`} className={styles.codeBlock} data-lang={seg.lang || undefined}>
              <code>{seg.code}</code>
            </pre>
          );
        }
        return (
          <div key={`text-${i}`} className={styles.text}>
            {renderText(seg.text, `md-${i}`)}
          </div>
        );
      })}
    </div>
  );
}
