// A tiny method + path router. Patterns are literal paths with `:name`
// segments (one path segment, never decoded) or a trailing `(.+)` capture.

export type Handler<C> = (c: C) => Promise<void>;

interface Route<C> {
  method: string;
  pattern: string;
  /** Parameter names, in order (`*` for a trailing capture). */
  names: string[];
  re: RegExp;
  handler: Handler<C>;
}

/**
 * A match carries the route's pattern (what logs, traces and metrics use: the
 * raw path may hold secrets) and its parameter names.
 */
export type Match<C> = { handler: Handler<C>; params: string[]; route: string; names: string[] } | { status: 404 | 405 };

export class Router<C> {
  private readonly routes: Route<C>[] = [];

  add(method: string, pattern: string, handler: Handler<C>): this {
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, "([^/]+)") + "$");
    const names = [...pattern.matchAll(/:(\w+)|\(\.\+\)/g)].map((m) => m[1] ?? "*");
    this.routes.push({ method, pattern, names, re, handler });
    return this;
  }

  get(pattern: string, handler: Handler<C>): this {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler<C>): this {
    return this.add("POST", pattern, handler);
  }
  put(pattern: string, handler: Handler<C>): this {
    return this.add("PUT", pattern, handler);
  }
  patch(pattern: string, handler: Handler<C>): this {
    return this.add("PATCH", pattern, handler);
  }
  delete(pattern: string, handler: Handler<C>): this {
    return this.add("DELETE", pattern, handler);
  }

  /** The handler for METHOD PATH (HEAD is GET), or 404 / 405. */
  match(method: string, pathname: string): Match<C> {
    const m = method === "HEAD" ? "GET" : method;
    let allowed = false;
    for (const r of this.routes) {
      const hit = r.re.exec(pathname);
      if (!hit) continue;
      allowed = true;
      if (r.method === m) return { handler: r.handler, params: hit.slice(1), route: r.pattern, names: r.names };
    }
    return { status: allowed ? 405 : 404 };
  }
}
