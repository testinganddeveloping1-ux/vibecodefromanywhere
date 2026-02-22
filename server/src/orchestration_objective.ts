function toNonEmpty(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s;
}

export function normalizeOrchestrationObjective(rawPrompt: string): string {
  const prompt = toNonEmpty(rawPrompt);
  if (!prompt) return "";

  const single = prompt.replace(/\s+/g, " ").trim();
  const inlineExplicit =
    single.match(/^you are coordinating(?: a team)?\.\s*(?:goal|objective)\s*:\s*(.+)$/i)?.[1] ||
    single.match(/^(?:goal|objective)\s*:\s*(.+)$/i)?.[1] ||
    "";
  if (inlineExplicit.trim()) return inlineExplicit.trim();

  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m =
      line.match(/^(?:[-*]\s*)?(?:goal|objective)\s*:\s*(.+)$/i) ||
      line.match(/^you are coordinating(?: a team)?\.\s*(?:goal|objective)\s*:\s*(.+)$/i);
    const candidate = toNonEmpty(m?.[1] ?? "");
    if (!candidate) continue;
    if (/<\s*prompt\s*>/i.test(candidate)) continue;
    if (candidate.length <= 2000) return candidate;
    return candidate.slice(0, 2000);
  }

  // Avoid leaking giant runtime prompts into worker task prompts when objective extraction fails.
  if (prompt.length > 2000) {
    const firstSentence = prompt.split(/\n+/)[0]?.trim() || prompt.slice(0, 2000);
    return firstSentence.slice(0, 2000);
  }
  return prompt;
}

export function ensureWorkerTaskIncludesObjective(taskPromptRaw: string, objectiveRaw: string): string {
  const taskPrompt = toNonEmpty(taskPromptRaw);
  const objective = toNonEmpty(objectiveRaw);
  if (!taskPrompt) return objective;
  if (!objective) return taskPrompt;

  const taskNorm = taskPrompt.toLowerCase();
  const objectiveNorm = objective.toLowerCase();
  const objectiveNeedle = objectiveNorm.slice(0, Math.min(160, objectiveNorm.length));
  if (objectiveNeedle && taskNorm.includes(objectiveNeedle)) return taskPrompt;
  return `${taskPrompt}\n\nOBJECTIVE CONTEXT (must be satisfied):\n${objective}`;
}
