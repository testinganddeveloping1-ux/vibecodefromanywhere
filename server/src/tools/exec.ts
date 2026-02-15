import { spawn } from "node:child_process";

export type ExecResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export async function execCapture(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const timeoutMs = opts?.timeoutMs ?? 2500;
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ ok: false, code: null, stdout, stderr, error: "timeout" });
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, code: null, stdout, stderr, error: e.message });
    });

    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

