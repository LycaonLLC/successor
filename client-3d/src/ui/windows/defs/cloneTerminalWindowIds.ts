/** Eager clone-terminal id + active terminal binding. */
export const CLONE_TERMINAL_WINDOW_ID = "clone-terminal";

let activeCloneTerminalId: string | null = null;

export function setActiveCloneTerminal(propId: string | null): void {
  activeCloneTerminalId = propId;
}

export function activeCloneTerminal(): string | null {
  return activeCloneTerminalId;
}
