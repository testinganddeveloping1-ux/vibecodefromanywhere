import { execSync } from "node:child_process";

export function resolveBinary(cmd: string): string | null {
  try {
    const out = execSync(`command -v ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

