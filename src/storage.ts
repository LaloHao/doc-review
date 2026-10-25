// Where the PDFs live: a directory (a PVC in the cluster) or an S3 bucket
// (Cloudflare R2), the same two options as the user's other services.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AwsClient } from "aws4fetch";
import type { StorageConfig } from "./config.js";

export interface BlobStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]*$/;

function checkKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes("..")) throw new Error(`invalid storage key: ${key}`);
}

export function fsStore(dir: string): BlobStore {
  const root = resolve(dir);
  return {
    async put(key, data) {
      checkKey(key);
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, path);
    },
    async get(key) {
      checkKey(key);
      try {
        return new Uint8Array(await readFile(join(root, key)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
  };
}

export function s3Store(
  c: Extract<StorageConfig, { type: "s3" }>,
  fetchImpl: typeof fetch = fetch,
): BlobStore {
  const aws = new AwsClient({
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    region: c.region,
    service: "s3",
  });
  const url = (key: string) =>
    `${c.endpoint}/${encodeURIComponent(c.bucket)}/${(c.prefix + key).split("/").map(encodeURIComponent).join("/")}`;
  return {
    async put(key, data, contentType) {
      checkKey(key);
      const req = await aws.sign(url(key), {
        method: "PUT",
        body: data as Uint8Array<ArrayBuffer>,
        headers: { "content-type": contentType },
      });
      const res = await fetchImpl(req);
      if (!res.ok) throw new Error(`S3 PUT failed: HTTP ${res.status}`);
    },
    async get(key) {
      checkKey(key);
      const req = await aws.sign(url(key), { method: "GET" });
      const res = await fetchImpl(req);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 GET failed: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

export function openStore(c: StorageConfig): BlobStore {
  return c.type === "fs" ? fsStore(c.dir) : s3Store(c);
}
