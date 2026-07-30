import { isMovementKey } from "./geometry";
import { isRotationLockKey, isSprintKey } from "./movementSystem";

export function isGameplayKey(code: string): boolean {
  return isMovementKey(code) || isRotationLockKey(code) || isSprintKey(code) || code === "Space";
}

/** Input types that actually EDIT TEXT — the only ones that own the keyboard. */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "password",
  "email",
  "url",
  "number",
  "tel",
]);

/**
 * True when the event target is a TEXT-EDITING control (text-ish input,
 * textarea, select, contenteditable). Non-text controls — range sliders,
 * checkboxes, radios, buttons — do NOT own the keyboard: a focused slider
 * swallowing WASD/Escape after a drag was the "movement stops after using
 * the options/inventory sliders" bug (owner report 2026-07-03).
 */
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  const control = target.closest("input, textarea, select, [contenteditable='true']");
  if (!control) return false;
  if (typeof HTMLInputElement !== "undefined" && control instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(control.type);
  }
  return true;
}
