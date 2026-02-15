// Minimal fake Codex App Server for unit tests.
// Speaks JSONL over stdio and implements just enough JSON-RPC to test our client.

import readline from "node:readline";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const raw = String(line ?? "").trim();
  if (!raw) continue;
  let msg = null;
  try {
    msg = JSON.parse(raw);
  } catch {
    continue;
  }

  // Client request / notification
  if (msg && typeof msg === "object" && typeof msg.method === "string") {
    const method = msg.method;
    const params = msg.params ?? null;

    if (method === "initialize" && msg.id != null) {
      send({ id: msg.id, result: { ok: true } });
      // After init, emit a server request that expects a response.
      send({
        id: 99,
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread_test", turnId: "turn_test", itemId: "item_test", reason: "fixture" },
      });
      continue;
    }

    if (method === "initialized") {
      // ignore
      continue;
    }

    if (msg.id != null) {
      send({ id: msg.id, result: { method, params } });
    }
    continue;
  }

  // Client response to our server request
  if (msg && typeof msg === "object" && msg.id != null && !Object.prototype.hasOwnProperty.call(msg, "method")) {
    send({ method: "test/responseReceived", params: { id: msg.id, result: msg.result ?? null, error: msg.error ?? null } });
  }
}

