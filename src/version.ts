// The app's version, from package.json (next to dist/ in the image, next to
// src/ in a checkout).

import { readFileSync } from "node:fs";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export const APP_VERSION = readVersion();
