import { pathToFileURL } from "node:url";

export const REMOTE_ENDPOINT_PROBE_SCHEMA = "successor.player-load-endpoint-probe.v1";

export async function probePlayerLoadEndpoint({ endpoint, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("endpoint probe timeout")), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(`${normalizeEndpoint(endpoint)}/game/status`, { signal: controller.signal });
    if (!response.ok) throw new Error(`endpoint status returned HTTP ${response.status}`);
    const status = await response.json();
    if (!status?.shardId || !status?.source?.stateHash || !status?.source?.sliceHash) {
      throw new Error("endpoint status lacks authoritative source metadata");
    }
    return {
      schema: REMOTE_ENDPOINT_PROBE_SCHEMA,
      status: "pass",
      endpoint: originFor(endpoint),
      shardId: String(status.shardId),
      source: { stateHash: String(status.source.stateHash), sliceHash: String(status.source.sliceHash) },
    };
  } catch (error) {
    return {
      schema: REMOTE_ENDPOINT_PROBE_SCHEMA,
      status: "fail",
      endpoint: originFor(endpoint),
      error: { code: error?.name === "AbortError" ? "ENDPOINT_TIMEOUT" : "ENDPOINT_UNREACHABLE" },
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEndpoint(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("endpoint must be a credential-free HTTP(S) origin");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function originFor(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const document = await probePlayerLoadEndpoint(request);
  process.stdout.write(`${JSON.stringify(document)}\n`);
  process.exitCode = document.status === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ schema: REMOTE_ENDPOINT_PROBE_SCHEMA, status: "fail", endpoint: null, error: { code: "INVALID_PROBE_REQUEST" } })}\n`);
    process.exitCode = 1;
  });
}
