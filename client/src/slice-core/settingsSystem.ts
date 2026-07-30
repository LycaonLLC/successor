export type InputActionId =
  | "moveUp"
  | "moveLeft"
  | "moveDown"
  | "moveRight"
  | "sprint"
  | "reload"
  | "interact"
  | "inventory"
  | "character"
  | "professions"
  | "options"
  | "keyboardFire";

export interface MouseRuntimeSettings {
  mouseSensitivity: number;
  cameraZoomPercent: number;
  showCombatCrosshair: boolean;
}

export interface RuntimeSettings {
  schema: "successor.runtime-settings.v1";
  mouse: MouseRuntimeSettings;
  bindings: Record<InputActionId, string[]>;
}

export interface RuntimeSettingsInput {
  schema?: RuntimeSettings["schema"];
  mouse?: Partial<MouseRuntimeSettings>;
  bindings?: Partial<Record<InputActionId, unknown>>;
}

export interface InputActionDefinition {
  id: InputActionId;
  label: string;
  help: string;
  defaultCodes: string[];
  canonicalGameplayCode?: string;
}

export const runtimeSettingsStorageKey = "successor.runtime-settings.v1";

// Widest-view (zoom-OUT) floor. Lower percent shows more of the map (see
// optionsPanel help text + camera.ts frustum math); this is the lever that
// bounds the worst-case visible half-diagonal, so it caps the no-pop-in /
// no-despawn-in-view guarantee. Aligned to the 3D client's existing floor
// (client-3d minZoomPercent 55): worst-case ground half-diagonal ≈ 24 cells
// at 1920×1080, a ~20-cell margin under the 44-cell spawn activation radius.
export const cameraZoomMinPercent = 55;
export const cameraZoomMaxPercent = 125;

export const defaultMouseRuntimeSettings: MouseRuntimeSettings = {
  mouseSensitivity: 1,
  cameraZoomPercent: 55,
  showCombatCrosshair: true,
};

export const inputActionDefinitions: InputActionDefinition[] = [
  { id: "moveUp", label: "Move up", help: "Move north / back", defaultCodes: ["KeyW", "ArrowUp"], canonicalGameplayCode: "KeyW" },
  { id: "moveLeft", label: "Move left", help: "Move west", defaultCodes: ["KeyA", "ArrowLeft"], canonicalGameplayCode: "KeyA" },
  { id: "moveDown", label: "Move down", help: "Move south / front", defaultCodes: ["KeyS", "ArrowDown"], canonicalGameplayCode: "KeyS" },
  { id: "moveRight", label: "Move right", help: "Move east", defaultCodes: ["KeyD", "ArrowRight"], canonicalGameplayCode: "KeyD" },
  { id: "sprint", label: "Run", help: "Hold to run — drains Action", defaultCodes: ["ShiftLeft", "ShiftRight", "Shift"], canonicalGameplayCode: "ShiftLeft" },
  { id: "keyboardFire", label: "Keyboard fire", help: "Fallback fire key", defaultCodes: ["Space"], canonicalGameplayCode: "Space" },
  { id: "reload", label: "Reload", help: "Reload active weapon", defaultCodes: ["KeyR"] },
  { id: "interact", label: "Interact", help: "Use / stabilize nearest target", defaultCodes: ["KeyF"] },
  { id: "inventory", label: "Inventory", help: "Open field pack", defaultCodes: ["KeyI"] },
  { id: "character", label: "Character", help: "Open character sheet", defaultCodes: ["KeyC"] },
  { id: "professions", label: "Professions", help: "Open profession skill trees", defaultCodes: ["Semicolon"] },
  { id: "options", label: "Options", help: "Open combat and input options", defaultCodes: ["KeyO"] },
];
const actionDefinitionsById = new Map(inputActionDefinitions.map((definition) => [definition.id, definition]));

function definedInputActionId(id: InputActionId): InputActionId {
  const definition = actionDefinitionsById.get(id);
  if (!definition) {
    throw new Error(`Missing input action definition: ${id}`);
  }
  return definition.id;
}

export const essentialInputActionIds = [
  definedInputActionId("moveUp"),
  definedInputActionId("moveLeft"),
  definedInputActionId("moveDown"),
  definedInputActionId("moveRight"),
] as const satisfies readonly InputActionId[];

export function createDefaultRuntimeSettings(): RuntimeSettings {
  const bindings = {} as Record<InputActionId, string[]>;
  for (const definition of inputActionDefinitions) {
    bindings[definition.id] = [...definition.defaultCodes];
  }
  return {
    schema: "successor.runtime-settings.v1",
    mouse: { ...defaultMouseRuntimeSettings },
    bindings,
  };
}

export function loadRuntimeSettings(storage: Pick<Storage, "getItem"> = window.localStorage): RuntimeSettings {
  const defaults = createDefaultRuntimeSettings();
  const raw = storage.getItem(runtimeSettingsStorageKey);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeSettings>;
    const settings = normalizeRuntimeSettings(parsed, defaults);
    for (const actionId of essentialInputActionIds) {
      if (settings.bindings[actionId].length === 0) {
        settings.bindings[actionId] = [...defaults.bindings[actionId]];
      }
    }
    return settings;
  } catch {
    return defaults;
  }
}

export function saveRuntimeSettings(settings: RuntimeSettings, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  storage.setItem(runtimeSettingsStorageKey, JSON.stringify(normalizeRuntimeSettings(settings)));
}

export function resetRuntimeSettings(storage?: Pick<Storage, "setItem">): RuntimeSettings {
  const settings = createDefaultRuntimeSettings();
  if (storage) saveRuntimeSettings(settings, storage);
  return settings;
}

export function setInputBinding(settings: RuntimeSettings, actionId: InputActionId, code: string): RuntimeSettings {
  const sanitized = sanitizeInputCode(code);
  if (!sanitized) return settings;
  const next = normalizeRuntimeSettings(settings);
  for (const action of inputActionDefinitions) {
    next.bindings[action.id] = next.bindings[action.id].filter((existing) => existing !== sanitized);
  }
  next.bindings[actionId] = [sanitized];
  return next;
}

export function inputActionForCode(settings: RuntimeSettings, code: string): InputActionId | null {
  for (const definition of inputActionDefinitions) {
    if (bindingMatches(settings, definition.id, code)) return definition.id;
  }
  return null;
}

export function bindingMatches(settings: RuntimeSettings, actionId: InputActionId, code: string): boolean {
  return (settings.bindings[actionId] ?? []).includes(code);
}

export function gameplayCodeForInput(settings: RuntimeSettings, code: string): string | null {
  if (code === "MouseRight") return "MouseRight";
  const actionId = inputActionForCode(settings, code);
  if (!actionId) return null;
  return actionDefinitionsById.get(actionId)?.canonicalGameplayCode ?? null;
}

export function labelForInputCode(code: string | undefined): string {
  if (!code) return "Unbound";
  const labels: Record<string, string> = {
    Alt: "Alt",
    AltLeft: "Left Alt",
    AltRight: "Right Alt",
    ArrowDown: "Down Arrow",
    ArrowLeft: "Left Arrow",
    ArrowRight: "Right Arrow",
    ArrowUp: "Up Arrow",
    ControlLeft: "Left Ctrl",
    ControlRight: "Right Ctrl",
    KeyA: "A",
    KeyC: "C",
    KeyD: "D",
    KeyF: "F",
    KeyI: "I",
    KeyO: "O",
    KeyR: "R",
    KeyS: "S",
    KeyW: "W",
    Semicolon: ";",
    Shift: "Shift",
    ShiftLeft: "Left Shift",
    ShiftRight: "Right Shift",
    Space: "Space",
  };
  if (labels[code]) return labels[code];
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return code;
}

export function normalizeRuntimeSettings(
  settings: RuntimeSettingsInput,
  defaults = createDefaultRuntimeSettings(),
): RuntimeSettings {
  const bindings = {} as Record<InputActionId, string[]>;
  for (const definition of inputActionDefinitions) {
    const rawCodes = settings.bindings?.[definition.id];
    if (Array.isArray(rawCodes)) {
      const codes = rawCodes.map(sanitizeInputCode).filter((code): code is string => Boolean(code));
      bindings[definition.id] = uniqueCodes(codes);
    } else {
      bindings[definition.id] = [...defaults.bindings[definition.id]];
    }
  }
  return {
    schema: "successor.runtime-settings.v1",
    mouse: normalizeMouseRuntimeSettings(settings.mouse, defaults.mouse),
    bindings,
  };
}

export function normalizeMouseRuntimeSettings(
  settings: Partial<MouseRuntimeSettings> | undefined,
  defaults = defaultMouseRuntimeSettings,
): MouseRuntimeSettings {
  return {
    mouseSensitivity: clampNumber(settings?.mouseSensitivity, 0.35, 2, defaults.mouseSensitivity),
    cameraZoomPercent: clampNumber(settings?.cameraZoomPercent, cameraZoomMinPercent, cameraZoomMaxPercent, defaults.cameraZoomPercent),
    showCombatCrosshair: typeof settings?.showCombatCrosshair === "boolean" ? settings.showCombatCrosshair : defaults.showCombatCrosshair,
  };
}

function sanitizeInputCode(code: string | undefined): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 32) return null;
  return trimmed;
}

function uniqueCodes(codes: string[]): string[] {
  return [...new Set(codes)];
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
