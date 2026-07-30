/** Eager association window id, chat bridge type, and terminal binding. */
export const PA_WINDOW_ID = "player-association";

let activePaTerminalId: string | null = null;

export function setActivePaTerminal(propId: string | null): void {
  activePaTerminalId = propId;
}

export function activePaTerminal(): string | null {
  return activePaTerminalId;
}

export interface PaWindowChatBridge {
  /** Submit one line to the GUILD channel; false when membership is missing. */
  sendGuildLine: (body: string) => boolean;
  /** Switch the HUD chat send channel to GUILD and focus its input. */
  selectGuildChannel: () => boolean;
}

export interface PaWindowDeps {
  sfx?: import("@successor/client/src/audio/sfx").SfxPlayer;
  chat?: PaWindowChatBridge;
}
