import { fetchJson } from "@successor/client/src/runtime/jsonFetch";
import { mapBundlePath, requireRuntimePublicPath, slicePath } from "@successor/client/src/slice-core/runtimePublicPaths";
import { validateRuntimeMapBundleForSlice, type SuccessorMapBundle } from "@successor/client/src/slice-core/mapBundleRuntimeContract";
import type { SliceSnapshot } from "@successor/client/src/slice-core/gameState";

export interface RuntimeAssetBundle {
  slice: SliceSnapshot;
  mapBundle: SuccessorMapBundle;
}

interface ProductionAssetManifest {
  schema: "successor-production-assets/v1";
  fixture: { identity: string };
  releaseId: string;
  contentHash: string;
}

export function isProductionAssetManifestCompatible(
  manifest: Pick<ProductionAssetManifest, "schema" | "fixture" | "releaseId" | "contentHash">,
  slice: Pick<SliceSnapshot, "stateHash">,
  expectedContentHash = import.meta.env.SUCCESSOR_ASSET_CONTENT_HASH,
  expectedReleaseId = import.meta.env.SUCCESSOR_ASSET_RELEASE_ID,
): boolean {
  return manifest.schema === "successor-production-assets/v1"
    && manifest.fixture?.identity === slice.stateHash
    && typeof manifest.releaseId === "string"
    && typeof manifest.contentHash === "string"
    && manifest.contentHash === expectedContentHash
    && manifest.releaseId === expectedReleaseId
    && manifest.releaseId.endsWith(`@${expectedContentHash.slice(0, 16)}`);
}

export async function assertProductionAssetManifestCompatibility(slice: SliceSnapshot): Promise<void> {
  if (typeof window === "undefined" || !import.meta.env.PROD) return;
  const manifest = await fetchJson<ProductionAssetManifest>(requireRuntimePublicPath("/production-asset-manifest.json"));
  if (!isProductionAssetManifestCompatible(manifest, slice)) {
    throw new Error("production asset manifest is incompatible with the loaded fixture");
  }
}

export async function loadRuntimeAssetBundle(): Promise<RuntimeAssetBundle> {
  const [slice, mapBundlePayload] = await Promise.all([
    fetchJson<SliceSnapshot>(slicePath),
    fetchJson<SuccessorMapBundle>(mapBundlePath),
  ]);
  await assertProductionAssetManifestCompatibility(slice);
  return {
    slice,
    mapBundle: validateRuntimeMapBundleForSlice(slice, mapBundlePayload),
  };
}
