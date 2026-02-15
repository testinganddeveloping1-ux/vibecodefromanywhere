export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...(init ?? {}) });
  if (res.status === 401) throw new Error("unauthorized");
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const isJson = ct.includes("application/json");
  if (!res.ok) {
    let msg = `http ${res.status}`;
    if (isJson) {
      try {
        const body: any = await res.json();
        if (typeof body?.message === "string" && body.message.trim()) msg = body.message.trim();
        else if (typeof body?.reason === "string" && body.reason.trim())
          msg = `${typeof body?.error === "string" ? body.error : "error"}: ${body.reason.trim()}`;
        else if (typeof body?.error === "string" && body.error.trim()) msg = body.error.trim();
      } catch {
        // ignore
      }
    } else {
      try {
        const text = await res.text();
        if (text.trim()) msg = text.trim().slice(0, 220);
      } catch {
        // ignore
      }
    }
    throw new Error(msg);
  }
  return (isJson ? await res.json() : ((await res.text()) as any)) as T;
}

