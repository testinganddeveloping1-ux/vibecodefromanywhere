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

  test("accepts x-fyp-token and upgrades to cookie", async () => {
    const dir = tmpDir();
    const app = await buildApp({ token: "t123", dataDir: dir });
    const res = await app.inject({
      method: "GET",
      url: "/api/doctor",
      headers: { "x-fyp-token": "t123" },
    });
    expect(res.statusCode).toBe(200);
    const setCookieRaw = res.headers["set-cookie"];
    const setCookie = Array.isArray(setCookieRaw) ? String(setCookieRaw[0] ?? "") : String(setCookieRaw ?? "");
    expect(setCookie).toContain("fyp_token=");

    const cookieHeader = setCookie.split(";")[0] ?? "";
    const res2 = await app.inject({
      method: "GET",
      url: "/api/doctor",
      headers: { cookie: cookieHeader },
    });
    expect(res2.statusCode).toBe(200);

    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects query token by default", async () => {
    const dir = tmpDir();
    const prev = process.env.FYP_ALLOW_QUERY_TOKEN_AUTH;
    delete process.env.FYP_ALLOW_QUERY_TOKEN_AUTH;
    const app = await buildApp({ token: "t123", dataDir: dir });
    const res = await app.inject({
      method: "GET",
      url: "/api/doctor?token=t123",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
    if (prev == null) delete process.env.FYP_ALLOW_QUERY_TOKEN_AUTH;
    else process.env.FYP_ALLOW_QUERY_TOKEN_AUTH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("accepts query token only when explicitly enabled", async () => {
    const dir = tmpDir();
    const prev = process.env.FYP_ALLOW_QUERY_TOKEN_AUTH;
    process.env.FYP_ALLOW_QUERY_TOKEN_AUTH = "1";
    const app = await buildApp({ token: "t123", dataDir: dir });
    const res = await app.inject({
      method: "GET",
      url: "/api/doctor?token=t123",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
    if (prev == null) delete process.env.FYP_ALLOW_QUERY_TOKEN_AUTH;
    else process.env.FYP_ALLOW_QUERY_TOKEN_AUTH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
