// The telemetry scope of the code that is running: the active span (for child
// spans and the trace_id of log lines) and, only with LOG_IDENTITIES, who made
// the request. Carried by AsyncLocalStorage, so it follows the request into
// database queries and into the notifications sent after the response.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Span } from "./trace.js";

/** Who made a request: only filled (and only logged) with LOG_IDENTITIES=true. */
export type Identity = Record<string, string | number>;

export interface Scope {
  span: Span | null;
  identity: Identity | null;
}

export const scopeStorage = new AsyncLocalStorage<Scope>();

export const currentScope = (): Scope | undefined => scopeStorage.getStore();

/** Runs fn with `patch` applied over the current scope. */
export function withScope<T>(patch: Partial<Scope>, fn: () => T): T {
  const cur = scopeStorage.getStore();
  return scopeStorage.run({ span: cur?.span ?? null, identity: cur?.identity ?? null, ...patch }, fn);
}
