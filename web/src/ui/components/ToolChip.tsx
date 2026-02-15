import type { ToolId } from "../types";

export function ToolChip({ tool }: { tool: ToolId }) {
  return <span className="chip chipOn">{tool}</span>;
}

