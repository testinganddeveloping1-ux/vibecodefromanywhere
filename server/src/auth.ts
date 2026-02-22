import type { FastifyPluginAsync } from "fastify";
import type { FastifyInstance } from "fastify";

export type AuthOptions = {
  token: string;
};

function extractToken(req: { headers: Record<string, any>; query?: any; cookies?: any }): {
  token: string | null;
  source: "none" | "bearer" | "header" | "cookie" | "query";
} {
  const h = req.headers ?? {};
  const auth = typeof h.authorization === "string" ? h.authorization : "";
  if (auth.toLowerCase().startsWith("bearer "))
    return { token: auth.slice(7).trim(), source: "bearer" };

  const x = typeof h["x-fyp-token"] === "string" ? h["x-fyp-token"] : "";
  if (x) return { token: x.trim(), source: "header" };

  const c = req.cookies && typeof req.cookies.fyp_token === "string" ? req.cookies.fyp_token : "";
  if (c) return { token: c.trim(), source: "cookie" };

  const allowQueryToken =
    String(process.env.FYP_ALLOW_QUERY_TOKEN_AUTH ?? "").trim().toLowerCase() === "1" ||
    String(process.env.FYP_ALLOW_QUERY_TOKEN_AUTH ?? "").trim().toLowerCase() === "true";
  if (allowQueryToken) {
    const q = (req as any).query;
    const qt = q && typeof q.token === "string" ? q.token : "";
    if (qt) return { token: qt.trim(), source: "query" };
  }

  return { token: null, source: "none" };
}

export const authPlugin: FastifyPluginAsync<AuthOptions> = async (app, opts) => {
  addAuthGuard(app, opts.token);
};

export function addAuthGuard(
  app: FastifyInstance,
  token: string,
  opts?: { onlyPrefixes?: string[]; exceptPrefixes?: string[] },
): void {
  const only = opts?.onlyPrefixes?.length ? opts.onlyPrefixes : null;
  const except = opts?.exceptPrefixes?.length ? opts.exceptPrefixes : null;
  app.addHook("preHandler", async (req, reply) => {
    if (only) {
      const url = (req as any).raw?.url ?? req.url;
      if (except && except.some((p) => String(url).startsWith(p))) return;
      if (!only.some((p) => String(url).startsWith(p))) return;
    }

    const { token: tok, source } = extractToken(req as any);
    if (!tok || tok !== token) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    // Upgrade explicit token auth to a cookie for smoother browser sessions.
    if (source === "query" || source === "header") {
      try {
        reply.setCookie("fyp_token", tok, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24 * 30,
        });
      } catch {
        // ignore if cookie plugin isn't registered
      }
    }
  });
}
