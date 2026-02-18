import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Some CLIs (notably OpenCode under Bun) can truncate large outputs when stdout is a pipe.
// Capturing stdout via a regular file avoids that class of truncation.
export async function execCaptureViaFile(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const timeoutMs = opts?.timeoutMs ?? 2500;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fromyourphone-"));
  const outPath = path.join(tmpDir, "stdout.txt");
  let outFd: number | null = null;
  try {
    outFd = fs.openSync(outPath, "w");
  } catch {
    // Fallback: if we can't open a temp file, use normal capture.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return await execCapture(cmd, args, opts);
  }

  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
      stdio: ["ignore", outFd as any, "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const finalize = (res: ExecResult) => {
      try {
        if (outFd != null) fs.closeSync(outFd);
      } catch {
        // ignore
      }
      outFd = null;
      let stdout = "";
      try {
        stdout = fs.readFileSync(outPath, "utf8");
      } catch {
        stdout = "";
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      resolve({ ...res, stdout, stderr });
    };

    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finalize({ ok: false, code: null, stdout: "", stderr, error: "timeout" });
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(t);
      finalize({ ok: false, code: null, stdout: "", stderr, error: e.message });
    });

    child.on("exit", (code) => {
      clearTimeout(t);
      finalize({ ok: code === 0, code, stdout: "", stderr });
    });
  });
}
