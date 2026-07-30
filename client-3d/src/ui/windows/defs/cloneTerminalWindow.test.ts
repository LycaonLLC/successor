// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlayState,
  type PlayState,
  type ServerAuthorityActorState,
  type ServerAuthorityBankState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import { createWindowManager, type WindowManager } from "../windowManager";
import {
  CLONE_TERMINAL_WINDOW_ID,
  createCloneTerminalWindowDefinition,
  setActiveCloneTerminal,
} from "./cloneTerminalWindow";

function fixtureSlice(): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 40,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 40, height: 24, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 40, height: 24, level: 0 }],
    stateHash: "clone-terminal-fixture",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "desert",
      label: "Subject",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "right",
      cell: { x: 4, y: 5 },
      route: [],
    }],
    props: [{
      id: "dustgate-clone-terminal",
      entity: "prop/clone-terminal",
      areaId: "desert",
      label: "Clone Terminal",
      kind: "clone_terminal",
      cell: { x: 5, y: 5 },
      size: { w: 1, h: 1 },
      interactive: true,
      solid: true,
      visible: true,
    }],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function fixtureBank(patch: Partial<ServerAuthorityBankState> = {}): ServerAuthorityBankState {
  return {
    credits: 2_500,
    items: [],
    backupPresent: false,
    backupSavedTick: null,
    backupSkillCount: 0,
    backupCost: 1000,
    ...patch,
  };
}

function mountClone(patch: {
  bank?: ServerAuthorityBankState | null;
  walletCredits?: number;
} = {}): { manager: WindowManager; state: PlayState; root: HTMLElement } {
  const slice = fixtureSlice();
  const state = createPlayState(slice);
  state.serverAuthority.playerActorId = "player";
  state.serverAuthority.snapshotTick = slice.tick;
  state.serverAuthority.actors.player = {
    id: "player",
    label: "Subject",
    areaId: "desert",
    x: 4.5,
    y: 5.5,
    direction: "right",
    lifeState: "alive",
    credits: patch.walletCredits ?? 5_000,
  } as ServerAuthorityActorState;
  state.serverAuthority.bank = patch.bank === undefined ? fixtureBank() : patch.bank;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const manager = createWindowManager({
    mount,
    state,
    slice,
    storageScope: `clone-terminal-${Math.random()}`,
  });
  manager.register(createCloneTerminalWindowDefinition());
  setActiveCloneTerminal("dustgate-clone-terminal");
  manager.open(CLONE_TERMINAL_WINDOW_ID);
  manager.update(0, 0);
  return { manager, state, root: manager.root };
}

afterEach(() => {
  setActiveCloneTerminal(null);
  document.body.textContent = "";
  localStorage.clear();
});

describe("clone terminal window", () => {
  it("queues the exact CloneSaveSkillBackup command from the single primary action", () => {
    const { manager, state, root } = mountClone();
    const save = root.querySelector<HTMLButtonElement>('[data-ref="save"]')!;
    expect(save.disabled).toBe(false);
    expect(save.textContent).toBe("SAVE BACKUP");
    save.click();
    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([
      { CloneSaveSkillBackup: {} },
    ]);
    manager.dispose();
  });

  it("shows the exact 1,000-credit cost from the authoritative projection", () => {
    const { manager, root } = mountClone();
    expect(root.querySelector('[data-ref="cost"]')!.textContent).toBe("1,000 CR");
    manager.dispose();
  });

  it("reads an existing backup as UPDATE with saved tick and skill count facts", () => {
    const { manager, root } = mountClone({
      bank: fixtureBank({ backupPresent: true, backupSavedTick: 40, backupSkillCount: 7 }),
    });
    expect(root.querySelector('[data-ref="backupStatus"]')!.textContent).toBe("BACKUP ON FILE");
    expect(root.querySelector('[data-ref="backupDetail"]')!.textContent).toContain("7 SKILL BOXES");
    expect(root.querySelector<HTMLButtonElement>('[data-ref="save"]')!.textContent).toBe("UPDATE BACKUP");
    manager.dispose();
  });

  it("disables the save while vault plus wallet cannot cover the cost", () => {
    const { manager, state, root } = mountClone({
      bank: fixtureBank({ credits: 300 }),
      walletCredits: 500,
    });
    const save = root.querySelector<HTMLButtonElement>('[data-ref="save"]')!;
    expect(save.disabled).toBe(true);
    save.click();
    expect(state.authorityCommands.pending).toEqual([]);
    manager.dispose();
  });

  it("renders the loading read while the projection has not streamed", () => {
    const { manager, root } = mountClone({ bank: null });
    expect(root.querySelector('[data-ref="backupStatus"]')!.textContent).toBe("READING RECORD…");
    expect(root.querySelector<HTMLButtonElement>('[data-ref="save"]')!.disabled).toBe(true);
    manager.dispose();
  });
});

describe("clone terminal balances line", () => {
  it("shows the exact vault and wallet balances beside the cost", () => {
    const { manager, root } = mountClone({ bank: fixtureBank({ credits: 2_500 }), walletCredits: 5_000 });
    expect(root.querySelector('[data-ref="balances"]')!.textContent).toBe("VAULT 2,500 CR · WALLET 5,000 CR");
    manager.dispose();
  });

  it("keeps the wallet honest while the vault record has not streamed", () => {
    const { manager, root } = mountClone({ bank: null, walletCredits: 750 });
    expect(root.querySelector('[data-ref="balances"]')!.textContent).toBe("VAULT — · WALLET 750 CR");
    manager.dispose();
  });
});
