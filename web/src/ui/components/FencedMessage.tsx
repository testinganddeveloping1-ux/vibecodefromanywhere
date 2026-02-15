export function FencedMessage({ text }: { text: string }) {
  const raw = String(text ?? "");
  const parts = raw.split("```");
  if (parts.length <= 1) return <div className="mdText">{raw}</div>;

  return (
    <div className="md">
      {parts.map((p, i) => {
        const isCode = i % 2 === 1;
        if (isCode) {
          const idx = p.indexOf("\n");
          const lang = idx >= 0 ? p.slice(0, idx).trim() : "";
          const code = (idx >= 0 ? p.slice(idx + 1) : p).replace(/\n$/, "");
          return (
            <pre key={i} className="mdCode" data-lang={lang || undefined}>
              <code>{code}</code>
            </pre>
          );
        }
        if (!p) return null;
        return (
          <div key={i} className="mdText">
            {p}
          </div>
        );
      })}
    </div>
  );
}

