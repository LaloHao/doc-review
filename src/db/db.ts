// A tiny SQL layer over two drivers that speak the same dialect:
// - `pg` against the cluster's CloudNativePG Postgres (production);
// - PGlite (Postgres compiled to WASM, in-process) for local development and tests,
//   so the same SQL and migrations run everywhere without a database server.

import { mkdirSync } from "node:fs";
import { MIGRATIONS } from "./migrations.js";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  tx<R>(fn: (q: Queryable) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

async function openPglite(url: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const path = url.slice("pglite:".length);
  let pg: InstanceType<typeof PGlite>;
  if (path === "" || path === "memory") {
    pg = new PGlite();
  } else {
    mkdirSync(path, { recursive: true });
    pg = new PGlite(path);
  }
  await pg.waitReady;
  // PGlite runs one query at a time; transactions are serialized through a queue so
  // that concurrent requests never interleave statements inside someone else's tx.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <R>(fn: () => Promise<R>): Promise<R> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    query: <T>(sql: string, params: unknown[] = []) =>
      serialize(async () => (await pg.query<T>(sql, params)).rows),
    tx: <R>(fn: (q: Queryable) => Promise<R>) =>
      serialize(() =>
        pg.transaction(async (t) =>
          fn({ query: async <T>(sql: string, params: unknown[] = []) => (await t.query<T>(sql, params)).rows }),
        ),
      ),
    close: () => pg.close(),
  };
}

async function openPg(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on("error", (err) => console.error("postgres pool error:", err.message));
  return {
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await pool.query(sql, params)).rows as T[],
    tx: async <R>(fn: (q: Queryable) => Promise<R>) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const r = await fn({
          query: async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
        });
        await client.query("commit");
        return r;
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function openDb(url: string): Promise<Db> {
  if (url.startsWith("pglite:")) return openPglite(url);
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return openPg(url);
  throw new Error("DATABASE_URL must be postgres://… or pglite:<dir>|pglite:memory");
}

/** Applies pending migrations, each in its own transaction. Returns the names applied. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await db.tx(async (q) => {
      for (const stmt of m.sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
        await q.query(stmt);
      }
      await q.query("insert into schema_migrations (name) values ($1)", [m.name]);
    });
    applied.push(m.name);
  }
  return applied;
}

/** Names of the migrations not applied yet (all of them on an empty database). */
export async function pendingMigrations(db: Queryable): Promise<string[]> {
  const [t] = await db.query<{ t: string | null }>("select to_regclass('schema_migrations')::text as t");
  if (!t?.t) return MIGRATIONS.map((m) => m.name);
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  return MIGRATIONS.filter((m) => !done.has(m.name)).map((m) => m.name);
}
