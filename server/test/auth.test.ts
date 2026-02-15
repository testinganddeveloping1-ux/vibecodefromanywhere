import { describe, expect, test } from "vitest";
import { buildApp } from "../src/app";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-"));
}

describe("auth", () => {
  test("rejects requests without token", async () => {
    const dir = tmpDir();
    const app = await buildApp({ token: "t123", dataDir: dir });
    const res = await app.inject({ method: "GET", url: "/api/doctor" });
    expect(res.statusCode).toBe(401);
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("accepts requests with Bearer token", async () => {
    const dir = tmpDir();
    const app = await buildApp({ token: "t123", dataDir: dir });
    const res = await app.inject({
      method: "GET",
      url: "/api/doctor",
      headers: { authorization: "Bearer t123" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
