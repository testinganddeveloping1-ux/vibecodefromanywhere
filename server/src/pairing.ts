import crypto from "node:crypto";

export type PairingRecord = {
  code: string;
  expiresAt: number;
  attemptsLeft: number;
};

function base32NoO(bytes: Buffer): string {
  // Crockford-ish alphabet without O/0/1/I for easier typing.
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export class PairingManager {
  private map = new Map<string, PairingRecord>();

  start(ttlMs = 2 * 60 * 1000): PairingRecord {
    const code = base32NoO(crypto.randomBytes(5)).slice(0, 8);
    const rec: PairingRecord = { code, expiresAt: Date.now() + ttlMs, attemptsLeft: 6 };
    this.map.set(code, rec);
    return rec;
  }

  claim(codeRaw: string): { ok: true } | { ok: false; reason: string } {
    const code = String(codeRaw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    const rec = this.map.get(code);
    if (!rec) return { ok: false, reason: "invalid_code" };
    if (Date.now() > rec.expiresAt) {
      this.map.delete(code);
      return { ok: false, reason: "expired" };
    }
    rec.attemptsLeft -= 1;
    if (rec.attemptsLeft < 0) {
      this.map.delete(code);
      return { ok: false, reason: "locked" };
    }
    // One-time use
    this.map.delete(code);
    return { ok: true };
  }

  gc(): void {
    const now = Date.now();
    for (const [k, v] of this.map) if (now > v.expiresAt) this.map.delete(k);
  }
}

