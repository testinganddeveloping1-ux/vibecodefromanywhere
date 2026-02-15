export type MacroKey =
  | "CTRL_C"
  | "ENTER"
  | "SHIFT_TAB"
  | "TAB"
  | "ESC"
  | "ARROW_UP"
  | "ARROW_DOWN"
  | "ARROW_LEFT"
  | "ARROW_RIGHT";

export type MacroStep =
  | { type: "text"; text: string }
  | { type: "keys"; keys: MacroKey[] };

const KEY_TO_SEQ: Record<MacroKey, string> = {
  CTRL_C: "\u0003",
  ENTER: "\r",
  TAB: "\t",
  SHIFT_TAB: "\u001b[Z", // BackTab
  ESC: "\u001b",
  ARROW_UP: "\u001b[A",
  ARROW_DOWN: "\u001b[B",
  ARROW_RIGHT: "\u001b[C",
  ARROW_LEFT: "\u001b[D",
};

export function macroToWrites(steps: MacroStep[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (step.type === "text") {
      out.push(step.text);
      continue;
    }
    for (const key of step.keys) {
      const seq = KEY_TO_SEQ[key];
      if (seq) out.push(seq);
    }
  }
  return out;
}
