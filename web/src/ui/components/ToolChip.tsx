import React from "react";
import type { ToolId } from "../types";
import { Chip } from "./Chip";

export function ToolChip({ tool }: { tool: ToolId }) {
  return <Chip active>{tool}</Chip>;
}
