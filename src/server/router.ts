// A tiny method + path router. Patterns are literal paths with `:name`
// segments (one path segment, never decoded) or a trailing `(.+)` capture.

export type Handler<C> = (c: C) => Promise<void>;

interface Route<C> {
  method: string;
  re: RegExp;
  handler: Handler<C>;
}

export type Match<C> = { handler: Handler<C>; params: string[] } | { status: 404 | 405 };

export class Router<C> {
  private readonly routes: Route<C>[] = [];

  add(method: string, pattern: string, handler: Handler<C>): this {
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, "([^/]+)") + "$");
    this.routes.push({ method, re, handler });
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
      if (r.method === m) return { handler: r.handler, params: hit.slice(1) };
    }
    return { status: allowed ? 405 : 404 };
  }
}
