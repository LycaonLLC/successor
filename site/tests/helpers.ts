import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROUTE_FILES = [
  "index.html",
  "alpha/index.html",
  "roadmap/index.html",
  "account/index.html",
  "connect/index.html",
  "play/index.html",
  "download/index.html",
  "legal/terms/index.html",
  "legal/privacy/index.html",
] as const;

export function sitePath(rel: string): string {
  // vitest runs with cwd = site/, which survives every transform.
  return join(process.cwd(), rel);
}

export function readPage(rel: string): string {
  return readFileSync(sitePath(rel), "utf8");
}

/** Mounts a real page's body (markup + body data attributes) into happy-dom. */
export function mountPage(rel: string): void {
  const html = readPage(rel);
  const bodyMatch = /<body([^>]*)>([\s\S]*)<\/body>/.exec(html);
  if (!bodyMatch) throw new Error(`no <body> in ${rel}`);
  for (const attr of document.body.getAttributeNames()) document.body.removeAttribute(attr);
  document.body.innerHTML = bodyMatch[2] ?? "";
  const attrs = bodyMatch[1] ?? "";
  for (const match of attrs.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
    const name = match[1];
    if (name) document.body.setAttribute(name, match[2] ?? "");
  }
}

export function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}
