// Typed contract for the same-origin /alpha-api/* service.
// Shapes follow the corrected standalone friends-alpha contract:
// callsign + password only, cookie sessions, CSRF on every mutation.

export interface SessionInfo {
  callsign: string;
  setup: {
    characterCount: number;
    maxCharacters: number;
  };
  legal?: unknown;
  status?: string;
}

export interface RegisterInput {
  callsign: string;
  password: string;
  legal?: {
    terms: string;
    privacy: string;
  };
}

export interface LoginInput {
  callsign: string;
  password: string;
}

/** Face-kit selection; ids/colors validated against server/src/game/face.gen.ts. */
export interface CharacterFaceConfig {
  eyes: string;
  brows: string;
  nose: string;
  mouth: string;
  eyeColor: string;
  browColor: string;
  lipColor: string;
}

export interface CharacterAppearance {
  body: "male" | "female";
  skinTone: string;
  /** Manifest hair id, or null for shaved. */
  hair: string | null;
  hairMat: string;
  face: CharacterFaceConfig | null;
}

export interface CharacterWornEntry {
  item: string;
  colors: string[];
}

export interface Character {
  id: string;
  name: string;
  initialProfessionId: string;
  worldEntryClaimed: boolean;
  appearance: CharacterAppearance;
  worn: CharacterWornEntry[];
}

export interface CharacterList {
  characters: Character[];
}

export interface CreateCharacterInput {
  name: string;
  initialProfessionId: string;
  appearance: CharacterAppearance;
  worn?: CharacterWornEntry[];
}

export interface DeviceAuthorization {
  id: string;
  kind: "authorization" | "credential";
  clientId: string;
  releaseId: string;
  status: string;
  expiresAt: number;
}

export interface DeviceList {
  devices: DeviceAuthorization[];
}

export interface LaunchContext {
  schema: "successor.launch-context.v1";
  gameTicket: string;
  chatTicket: string;
  endpoints: { game: string; chat: string };
  release: { client: string; server: string; shard: string };
  characterId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface DownloadBuild {
  targetId: string;
  client?: string;
  platform?: string;
  version: string;
  publishedAt: string;
  sizeBytes: number;
  sha256: string;
  url: string;
  requirements?: string;
  releaseId?: string;
}

export interface DownloadManifest {
  schema?: string;
  builds: DownloadBuild[];
}

export type ApiError =
  | { kind: "unavailable"; message: string }
  | { kind: "rejected"; status: number; code: string; message: string; body?: unknown };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface MacroRecordItem {
  id: string;
  name: string;
  iconId: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MacroListPayload {
  schema?: string;
  characterId?: string;
  recordKind?: string;
  version?: number;
  etag: string;
  record?: { version: number; items: MacroRecordItem[] };
  caps: {
    maxItems: number;
    maxBodyBytes: number;
    maxNameCharacters: number;
    maxIconIdCharacters?: number;
  };
  macros: MacroRecordItem[];
  macro?: MacroRecordItem;
  error?: string;
}
