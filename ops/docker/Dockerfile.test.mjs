import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
const dockerignore = await readFile(new URL("../../.dockerignore", import.meta.url), "utf8");

test("authority image uses a narrow cacheable Node build context", () => {
  assert.doesNotMatch(dockerfile, /COPY \. \./);
  const manifests = dockerfile.indexOf("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./");
  const install = dockerfile.indexOf("pnpm install --frozen-lockfile --store-dir=/pnpm/store --filter @successor/server... --filter @successor/client...");
  const serverSource = dockerfile.indexOf("COPY server ./server");
  assert.ok(manifests >= 0 && install > manifests && serverSource > install);
  assert.match(dockerfile, /COPY client \.\/client/);
  assert.match(dockerfile, /COPY tools\/codegen\/generated \.\/tools\/codegen\/generated/);
  assert.match(dockerfile, /COPY crates \.\/crates/);
});

test("authority context excludes public client authoring trees only", () => {
  for (const excluded of ["client-3d", "client-tui", "desktop", "site", "content-pipeline", "verification"]) {
    assert.match(dockerignore, new RegExp(`^${excluded}$`, "m"));
  }
  for (const required of ["client", "server", "crates", "tools"]) {
    assert.doesNotMatch(dockerignore, new RegExp(`^${required}$`, "m"));
  }
});
