import type { FastifyPluginAsync } from "fastify";
import type { FastifyInstance } from "fastify";

export type AuthOptions = {
  token: string;
};

function extractToken(req: { headers: Record<string, any>; query?: any; cookies?: any }): {
  token: string | null;
  fromQuery: boolean;
} {
  const h = req.headers ?? {};
  const auth = typeof h.authorization === "string" ? h.authorization : "";
  if (auth.toLowerCase().startsWith("bearer "))
    return { token: auth.slice(7).trim(), fromQuery: false };

  const x = typeof h["x-fyp-token"] === "string" ? h["x-fyp-token"] : "";
  if (x) return { token: x.trim(), fromQuery: false };

  const c = req.cookies && typeof req.cookies.fyp_token === "string" ? req.cookies.fyp_token : "";
  if (c) return { token: c.trim(), fromQuery: false };

  const q = (req as any).query;
  const qt = q && typeof q.token === "string" ? q.token : "";
  if (qt) return { token: qt.trim(), fromQuery: true };

  return { token: null, fromQuery: false };
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

    const { token: tok, fromQuery } = extractToken(req as any);
    if (!tok || tok !== token) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    // If you arrived with ?token=..., upgrade to a cookie so asset requests work.
    if (fromQuery) {
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
