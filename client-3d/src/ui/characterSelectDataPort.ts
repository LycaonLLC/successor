import type {
  CharacterApiRecord,
  CharacterEnterJoin,
  CharactersResponse,
} from "./characterSelect";
import type { CharDollAppearance } from "./charDollPreview";

export interface CharacterCreateInput {
  name: string;
  appearance: CharDollAppearance;
  initialProfessionId: string;
}

export interface CharacterCreateResult {
  ok: boolean;
  record?: CharacterApiRecord;
  error?: string;
}

export interface CharacterSelectResult {
  ok: boolean;
  join?: CharacterEnterJoin;
  error?: string;
}

/** Transport boundary for the roster/create/ENTER WORLD actions. */
export interface CharacterSelectDataPort {
  readonly hosted: boolean;
  list(): Promise<CharactersResponse>;
  create(input: CharacterCreateInput): Promise<CharacterCreateResult>;
  select(characterId: string): Promise<CharacterSelectResult>;
}

export function createLegacyCharacterSelectDataPort(apiBase: string): CharacterSelectDataPort {
  return {
    hosted: false,
    async list() {
      const response = await fetch(`${apiBase}/game/characters`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`status ${response.status}`);
      return (await response.json()) as CharactersResponse;
    },
    async create(input) {
      try {
        const response = await fetch(`${apiBase}/game/characters`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (response.ok || response.status === 201) {
          return { ok: true, record: (await response.json()) as CharacterApiRecord };
        }
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: body.error ?? "create_failed" };
      } catch {
        return { ok: false, error: "create_failed" };
      }
    },
    async select(characterId) {
      try {
        const response = await fetch(`${apiBase}/game/characters/${encodeURIComponent(characterId)}/enter`, { method: "POST" });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: body.error ?? "enter_failed" };
        }
        const data = (await response.json()) as { ok: boolean; join: CharacterEnterJoin };
        return { ok: data.ok !== false, join: data.join };
      } catch {
        return { ok: false, error: "enter_failed" };
      }
    },
  };
}

