import { describe, expect, it } from "vitest";

import {
  authorityDirectionFromFacing,
  authorityIssuedAtTick,
  authorityIssuedAtServerTick,
  authorityMoveCommandIntervalMs,
  authorityMoveIntentDurationTicks,
  authorityMoveCommand,
  authorityMoveIntentCommand,
  authorityCommandKind,
  clearAuthorityCommandQueue,
  createEmptyAuthorityCommandKindCounts,
  createAuthorityCommandQueue,
  deferInFlightAuthorityCommand,
  enqueueAuthorityCommand,
  enqueueAuthorityAcceptTradeCommand,
  enqueueAuthorityCancelAbilityQueueCommand,
  enqueueAuthorityCloneRespawnCommand,
  enqueueAuthorityBankStoreItemCommand,
  enqueueAuthorityBankRetrieveItemCommand,
  enqueueAuthorityBankDepositCreditsCommand,
  enqueueAuthorityBankWithdrawCreditsCommand,
  enqueueAuthorityCloneSaveSkillBackupCommand,
  enqueueAuthorityCorpseTakeCreditsCommand,
  enqueueAuthorityCraftItemCommand,
  enqueueAuthorityDiscardStackCommand,
  enqueueAuthorityDeclineTradeCommand,
  enqueueAuthorityCollectExtractorCommand,
  enqueueAuthorityCrankExtractorCommand,
  enqueueAuthorityDestroyExtractorCommand,
  enqueueAuthorityInsertBatteryCommand,
  enqueueAuthorityHarvestCorpseCommand,
  enqueueAuthorityTakeLootItemCommand,
  enqueueAuthorityPurchaseTravelTicketCommand,
  enqueueAuthorityMoveCommand,
  enqueueAuthorityMoveIntentCommand,
  enqueueAuthorityPlaceExtractorCommand,
  enqueueAuthorityProposeTradeCommand,
  enqueueAuthorityPeaceCommand,
  enqueueAuthorityRetrieveFromExchangeCommand,
  enqueueAuthorityReviveActorCommand,
  enqueueAuthoritySampleResourceCommand,
  enqueueAuthorityStopResourceSampleCommand,
  enqueueAuthoritySetCareerGoalCommand,
  enqueueAuthoritySetProfessionTitleCommand,
  enqueueAuthorityUnlearnSkillBoxCommand,
  enqueueAuthoritySetEquippedWeaponCommand,
  enqueueAuthoritySetEquippedClothingCommand,
  enqueueAuthoritySurveyResourceCommand,
  enqueueAuthorityStopCrankCommand,
  enqueueAuthorityStoreToExchangeCommand,
  enqueueAuthorityTransitionCommand,
  enqueueAuthorityUseConsumableCommand,
  enqueueAuthorityUseTravelTicketCommand,
  enqueueAuthorityToggleDoorCommand,
  nextRuntimeAuthorityCommandIdFloor,
  settleAuthorityCommand,
} from "./authorityCommandSystem";
import type { ExchangeTradeItem } from "./authorityCommandSystem";


describe("authorityCommandSystem", () => {
  it("enqueues an exact DiscardStack command and classifies it", () => {
    const queue = createAuthorityCommandQueue(3, 9);
    const envelope = enqueueAuthorityDiscardStackCommand(queue, "player:field-pack", "7", 2_001, 7, 40);
    expect(envelope?.command).toEqual({
      DiscardStack: { container: "player:field-pack", stack_id: "7", item_id: 2_001, variant_id: 7 },
    });
    expect(authorityCommandKind(envelope!.command)).toBe("DiscardStack");
    expect(queue.totalByKind.DiscardStack).toBe(1);
    expect(enqueueAuthorityDiscardStackCommand(queue, "", "7", 2_001, 7, 41)).toBeNull();
  });

  it("enqueues group commands through the generic path and buckets them by kind", () => {
    const queue = createAuthorityCommandQueue(3, 9);
    const invite = enqueueAuthorityCommand(queue, { GroupInvite: { target_actor_id: "p2" } }, 40);
    expect(invite.command).toEqual({ GroupInvite: { target_actor_id: "p2" } });
    expect(invite.session).toBe(3);
    expect(invite.player).toBe(9);
    expect(invite.issued_at_tick).toBe(40);
    enqueueAuthorityCommand(queue, { GroupAccept: {} }, 41);
    enqueueAuthorityCommand(queue, { GroupKick: { target_actor_id: "p3" } }, 42);
    expect(authorityCommandKind({ GroupInvite: { target_actor_id: "p2" } })).toBe("GroupInvite");
    expect(authorityCommandKind({ GroupAccept: {} })).toBe("GroupAccept");
    expect(authorityCommandKind({ GroupDecline: {} })).toBe("GroupDecline");
    expect(authorityCommandKind({ GroupLeave: {} })).toBe("GroupLeave");
    expect(authorityCommandKind({ GroupDisband: {} })).toBe("GroupDisband");
    expect(authorityCommandKind({ GroupKick: { target_actor_id: "p3" } })).toBe("GroupKick");
    expect(queue.totalByKind.GroupInvite).toBe(1);
    expect(queue.totalByKind.GroupAccept).toBe(1);
    expect(queue.totalByKind.GroupKick).toBe(1);
  });

  it("starts real reconnect queues above persisted command ids", () => {
    const queue = createAuthorityCommandQueue(7, 11, 1_783_806_000_000);
    const envelope = enqueueAuthorityTransitionCommand(queue, "test-entry", 42)!;

    expect(envelope.command_id).toBe(1_783_806_000_000);
    expect(queue.nextCommandId).toBe(1_783_806_000_001);
  });

  it("separates real clients created during the same millisecond", () => {
    const first = nextRuntimeAuthorityCommandIdFloor(1_783_806_000_000);
    const second = nextRuntimeAuthorityCommandIdFloor(1_783_806_000_000);

    expect(second).toBe(first + 1);
    expect(Number.isSafeInteger(first)).toBe(true);
  });

  it("serializes equipped weapon item ids for presentation-distinct weapons", () => {
    const queue = createAuthorityCommandQueue();
    const envelope = enqueueAuthoritySetEquippedWeaponCommand(queue, 13, "vibrosword", 3104, 9);

    expect(envelope.command).toEqual({
      SetEquippedWeapon: {
        weapon_id: "vibrosword",
        weapon_item_id: 3104,
        weapon_variant_id: 9,
      },
    });
    expect(queue.totalByKind.SetEquippedWeapon).toBe(1);
  });

  it("serializes exact equipped clothing identity and settles its receipt by command id", () => {
    const queue = createAuthorityCommandQueue(13, 21);
    const envelope = enqueueAuthoritySetEquippedClothingCommand(
      queue,
      37,
      4_205.9,
      true,
      "73",
      60_000_105,
      "player:field-pack",
    );

    expect(envelope).toEqual({
      session: 13,
      player: 21,
      command_id: 1,
      issued_at_tick: 37,
      command: {
        SetEquippedClothing: {
          item_id: 4205,
          equipped: true,
          container: "player:field-pack",
          stack_id: "73",
          variant_id: 60_000_105,
        },
      },
    });
    expect(authorityCommandKind(envelope.command)).toBe("SetEquippedClothing");
    expect(queue.totalByKind.SetEquippedClothing).toBe(1);
    expect(queue.pending).toEqual([envelope]);

    queue.inFlight = queue.pending.shift() ?? null;
    expect(settleAuthorityCommand(queue, envelope.command_id)).toBe(true);
    expect(queue.inFlight).toBeNull();
  });


  it("validates one-step cardinal and diagonal movement commands before enqueue", () => {
    expect(authorityMoveCommand(1, 0, 3)).toEqual({
      Move: { dx: 1, dy: 0, duration_ticks: 3 },
    });
    expect(authorityMoveCommand(1, 1, 3)).toEqual({
      Move: { dx: 1, dy: 1, duration_ticks: 3 },
    });
    expect(authorityMoveCommand(1, 0, 3, true)).toEqual({
      Move: { dx: 1, dy: 0, duration_ticks: 3, sprint: true },
    });
    expect(authorityMoveCommand(0, 0, 3)).toBeNull();
    expect(authorityMoveCommand(2, 0, 3)).toBeNull();
    expect(authorityMoveCommand(0, -1, 31)).toBeNull();

    const queue = createAuthorityCommandQueue();
    expect(enqueueAuthorityMoveCommand(queue, 0, -1, 2, 8)?.command).toEqual({
      Move: { dx: 0, dy: -1, duration_ticks: 2 },
    });
    expect(enqueueAuthorityMoveCommand(queue, 1, 1, 2, 9, true)?.command).toEqual({
      Move: { dx: 1, dy: 1, duration_ticks: 2, sprint: true },
    });
    expect(enqueueAuthorityMoveCommand(queue, 0, 0, 2, 10)).toBeNull();
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      Move: 2,
    });
    expect(queue.pending).toHaveLength(2);
  });

  it("validates held movement intent edges including stop intents", () => {
    expect(authorityMoveIntentCommand(1, 0, "Right")).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    });
    expect(authorityMoveIntentCommand(0, 0, "Right", true)).toEqual({
      SetMoveIntent: { dx: 0, dy: 0, facing: "Right" },
    });
    expect(authorityMoveIntentCommand(2, 0)).toBeNull();

    const queue = createAuthorityCommandQueue();
    expect(enqueueAuthorityMoveIntentCommand(queue, 0, -1, 12, "Back", true)?.command).toEqual({
      SetMoveIntent: { dx: 0, dy: -1, facing: "Back", sprint: true },
    });
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      SetMoveIntent: 1,
    });
  });

  it("keeps product move intents at the two-tick cadence", () => {
    expect(authorityMoveIntentDurationTicks(30)).toBe(2);
    expect(authorityMoveCommandIntervalMs(30)).toBeCloseTo(1000 * (2 / 30));
    expect(authorityMoveIntentDurationTicks(60)).toBe(3);
  });

  it("matches Rust direction and transition payload shape", () => {
    expect(authorityDirectionFromFacing("front")).toBe("Front");
    expect(authorityDirectionFromFacing("right")).toBe("Right");
    expect(authorityDirectionFromFacing("back")).toBe("Back");
    expect(authorityDirectionFromFacing("left")).toBe("Left");

    const queue = createAuthorityCommandQueue();
    expect(enqueueAuthorityTransitionCommand(queue, " bolt-bench-entry ", 12)?.command).toEqual({
      EnterTransition: { transition_id: "bolt-bench-entry" },
    });
    expect(enqueueAuthorityTransitionCommand(queue, " ", 13)).toBeNull();
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      EnterTransition: 1,
    });
  });

  it("emits authoritative clone respawn commands with optional facility ids", () => {
    const queue = createAuthorityCommandQueue();
    const nearest = enqueueAuthorityCloneRespawnCommand(queue, 14);
    const selected = enqueueAuthorityCloneRespawnCommand(queue, 15, "camp-clone-vat");

    expect(nearest.command).toEqual({ CloneRespawn: {} });
    expect(selected.command).toEqual({ CloneRespawn: { facility_id: "camp-clone-vat" } });
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      CloneRespawn: 2,
    });
  });

  it("emits authoritative revive actor commands", () => {
    const queue = createAuthorityCommandQueue();

    expect(enqueueAuthorityReviveActorCommand(queue, "  desert-warden-agent-wing-02 ", 15)?.command).toEqual({
      ReviveActor: { target_actor_id: "desert-warden-agent-wing-02" },
    });
    expect(enqueueAuthorityReviveActorCommand(queue, " ", 16)).toBeNull();
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      ReviveActor: 1,
    });
  });

  it("emits roll-combat peace commands", () => {
    const queue = createAuthorityCommandQueue();

    expect(enqueueAuthorityPeaceCommand(queue, 16).command).toEqual({ Peace: {} });
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      Peace: 1,
    });
  });

  it("emits scoped ability queue cancel commands", () => {
    const queue = createAuthorityCommandQueue();

    expect(enqueueAuthorityCancelAbilityQueueCommand(queue, 17, { scope: "owner_repeat" })?.command).toEqual({
      CancelAbilityQueue: { scope: "owner_repeat" },
    });
    expect(enqueueAuthorityCancelAbilityQueueCommand(queue, 18, { queueEntryId: "q_1" })?.command).toEqual({
      CancelAbilityQueue: { queue_entry_id: "q_1" },
    });
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      CancelAbilityQueue: 2,
    });
  });

  it("emits exact consumable stack commands", () => {
    const queue = createAuthorityCommandQueue();

    expect(enqueueAuthorityUseConsumableCommand(queue, " stimpak_a ", 18, 1001, 7)?.command).toEqual({
      UseConsumable: {
        item_id: "stimpak_a",
        item_numeric_id: 1001,
        variant_id: 7,
      },
    });
    expect(enqueueAuthorityUseConsumableCommand(queue, "field_bandage", 19)?.command).toEqual({
      UseConsumable: { item_id: "field_bandage" },
    });
    expect(enqueueAuthorityUseConsumableCommand(queue, " ", 20)).toBeNull();
    expect(enqueueAuthorityUseConsumableCommand(queue, "stimpak_a", 21, -1)).toBeNull();
    expect(enqueueAuthorityUseConsumableCommand(queue, "stimpak_a", 22, 1001, -1)).toBeNull();
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      UseConsumable: 2,
    });
  });


  it("emits travel ticket purchase and use commands", () => {
    const queue = createAuthorityCommandQueue(3, 5);
    const purchase = enqueueAuthorityPurchaseTravelTicketCommand(queue, {
      terminalPropId: " travel-terminal-dustgate ",
      toPlanetId: " verdance ",
      toCityId: " lowbough ",
    }, 23);
    const use = enqueueAuthorityUseTravelTicketCommand(queue, {
      container: " player:field-pack ",
      stackId: " 7 ",
      ticketId: " player:travel:23 ",
      variantId: 23,
    }, 24);
    expect(purchase?.command).toEqual({
      PurchaseTravelTicket: {
        terminal_prop_id: "travel-terminal-dustgate",
        to_planet_id: "verdance",
        to_city_id: "lowbough",
      },
    });
    expect(use?.command).toEqual({
      UseTravelTicket: {
        container: "player:field-pack",
        stack_id: "7",
        ticket_id: "player:travel:23",
        item_id: "travel_ticket",
        item_numeric_id: 5001,
        variant_id: 23,
      },
    });
    expect(enqueueAuthorityPurchaseTravelTicketCommand(queue, { terminalPropId: "", toPlanetId: "verdance", toCityId: "lowbough" }, 25)).toBeNull();
    expect(enqueueAuthorityUseTravelTicketCommand(queue, { variantId: -1 }, 26)).toBeNull();
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      PurchaseTravelTicket: 1,
      UseTravelTicket: 1,
    });
  });
  it("emits authoritative door toggle commands", () => {
    const queue = createAuthorityCommandQueue(4, 6);

    expect(enqueueAuthorityToggleDoorCommand(queue, " shelter house ! ", 31)?.command).toEqual({
      ToggleDoor: { prop_id: "shelterhouse" },
    });
    expect(enqueueAuthorityToggleDoorCommand(queue, " ", 32)).toBeNull();
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      ToggleDoor: 1,
    });
  });

  it("emits profession title selection commands", () => {
    const queue = createAuthorityCommandQueue();

    expect(enqueueAuthoritySetProfessionTitleCommand(queue, " scout-novice ", 17)?.command).toEqual({
      SetProfessionTitle: { title_id: "scout-novice" },
    });
    expect(enqueueAuthoritySetProfessionTitleCommand(queue, null, 18)?.command).toEqual({
      SetProfessionTitle: { title_id: null },
    });
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      SetProfessionTitle: 2,
    });
  });

  it("emits career goal respec commands", () => {
    const queue = createAuthorityCommandQueue();

    expect(enqueueAuthoritySetCareerGoalCommand(queue, " rifle_utility ", " profession-trainer-01 ", 19)?.command).toEqual({
      SetCareerGoal: { goal_id: "rifle_utility", trainer_actor_id: "profession-trainer-01" },
    });
    expect(enqueueAuthoritySetCareerGoalCommand(queue, " ", "profession-trainer-01", 20)).toBeNull();
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      SetCareerGoal: 1,
    });
  });

  it("emits trainer-facing per-box unlearn commands", () => {
    const queue = createAuthorityCommandQueue();

    expect(enqueueAuthorityUnlearnSkillBoxCommand(
      queue,
      " marksman-rifle-i ",
      " profession-trainer-01 ",
      21,
    )?.command).toEqual({
      UnlearnSkillBox: {
        skill_box_id: "marksman-rifle-i",
        trainer_actor_id: "profession-trainer-01",
      },
    });
    expect(enqueueAuthorityUnlearnSkillBoxCommand(queue, " ", "profession-trainer-01", 22)).toBeNull();
    expect(enqueueAuthorityUnlearnSkillBoxCommand(queue, "marksman-rifle-i", " ", 23)).toBeNull();
    expect(queue.totalByKind).toEqual({
      ...createEmptyAuthorityCommandKindCounts(),
      UnlearnSkillBox: 1,
    });
  });

  it("emits resource, harvest, and crafting commands", () => {
    const queue = createAuthorityCommandQueue();

    expect(enqueueAuthoritySampleResourceCommand(queue, "mineral", 20)?.command).toEqual({
      SampleResource: { family: "mineral" },
    });
    expect(enqueueAuthorityStopResourceSampleCommand(queue, "mineral", 20)?.command).toEqual({
      SampleResource: { family: "mineral", stop: true },
    });
    expect(enqueueAuthoritySurveyResourceCommand(queue, "chemical", 20)?.command).toEqual({
      SurveyResource: { family: "chemical" },
    });
    expect(enqueueAuthorityHarvestCorpseCommand(queue, "gaia-creature-1", 21)?.command).toEqual({
      HarvestCorpse: { target_actor_id: "gaia-creature-1" },
    });
    expect(enqueueAuthorityTakeLootItemCommand(queue, " corpse:open-desert-rogue-006-01 ", 1101, 0, 12, 22)?.command).toEqual({
      TakeLootItem: { container: "corpse:open-desert-rogue-006-01", itemId: 1101, variantId: 0, quantity: 12 },
    });
    expect(enqueueAuthorityTakeLootItemCommand(queue, "cache:open-desert-cache-01", 1002, 0, 0, 23)).toBeNull();
    expect(enqueueAuthorityCraftItemCommand(queue, "slugthrower", 23, { power: 12, handling: 4, reliability: 4 })?.command).toEqual({
      CraftItem: {
        schematic_id: "slugthrower",
        experiment_power: 12,
        experiment_handling: 4,
        experiment_reliability: 4,
      },
    });
    expect(queue.totalByKind.SampleResource).toBe(2);
    expect(queue.totalByKind.SurveyResource).toBe(1);
    expect(queue.totalByKind.HarvestCorpse).toBe(1);
    expect(queue.totalByKind.TakeLootItem).toBe(1);
    expect(queue.totalByKind.CraftItem).toBe(1);
    expect(queue.totalByKind.EnterTransition).toBe(0);
  });

  it("emits extractor placement and control commands", () => {
    const queue = createAuthorityCommandQueue();

    expect(enqueueAuthorityPlaceExtractorCommand(queue, " mineral ", 24)?.command).toEqual({
      PlaceExtractor: { family: "mineral" },
    });
    expect(enqueueAuthorityCrankExtractorCommand(queue, " extractor:player:1 ", 25)?.command).toEqual({
      CrankExtractor: { extractor_id: "extractor:player:1" },
    });
    expect(enqueueAuthorityStopCrankCommand(queue, 26).command).toEqual({ StopCrank: {} });
    expect(enqueueAuthorityInsertBatteryCommand(queue, { extractorId: " extractor:player:1 ", container: " player:field-pack ", stackId: " 7 ", variantId: 32_000_060 }, 27)?.command).toEqual({
      InsertBattery: { extractor_id: "extractor:player:1", container: "player:field-pack", stack_id: "7", variant_id: 32_000_060 },
    });
    expect(enqueueAuthorityCollectExtractorCommand(queue, " extractor:player:1 ", 28)?.command).toEqual({
      CollectExtractor: { extractor_id: "extractor:player:1" },
    });
    expect(enqueueAuthorityDestroyExtractorCommand(queue, " extractor:player:1 ", 29)?.command).toEqual({
      DestroyExtractor: { extractor_id: "extractor:player:1" },
    });
    expect(enqueueAuthorityPlaceExtractorCommand(queue, " ", 29)).toBeNull();
    expect(enqueueAuthorityCrankExtractorCommand(queue, " ", 30)).toBeNull();
    expect(enqueueAuthorityCollectExtractorCommand(queue, " ", 31)).toBeNull();
    expect(enqueueAuthorityDestroyExtractorCommand(queue, " ", 32)).toBeNull();
    expect(enqueueAuthorityInsertBatteryCommand(queue, { extractorId: "", container: "player:field-pack", stackId: "7", variantId: 32_000_060 }, 33)).toBeNull();
    expect(enqueueAuthorityInsertBatteryCommand(queue, { extractorId: "extractor:player:1", container: " ", stackId: "7", variantId: 32_000_060 }, 34)).toBeNull();
    expect(enqueueAuthorityInsertBatteryCommand(queue, { extractorId: "extractor:player:1", container: "player:field-pack", stackId: " ", variantId: 32_000_060 }, 35)).toBeNull();
    expect(enqueueAuthorityInsertBatteryCommand(queue, { extractorId: "extractor:player:1", container: "player:field-pack", stackId: "7", variantId: -1 }, 36)).toBeNull();
    expect(queue.totalByKind).toMatchObject({
      PlaceExtractor: 1,
      CrankExtractor: 1,
      StopCrank: 1,
      InsertBattery: 1,
      CollectExtractor: 1,
      DestroyExtractor: 1,
    });
  });

  it("emits exchange and secure-trade commands", () => {
    const queue = createAuthorityCommandQueue();
    expect(enqueueAuthorityStoreToExchangeCommand(queue, 2001, 210005, 12, 30)?.command).toEqual({
      StoreToExchange: { item_id: 2001, variant_id: 210005, quantity: 12 },
    });
    expect(enqueueAuthorityRetrieveFromExchangeCommand(queue, 1001, 0, 3, 31)?.command).toEqual({
      RetrieveFromExchange: { item_id: 1001, variant_id: 0, quantity: 3 },
    });
    expect(
      enqueueAuthorityProposeTradeCommand(
        queue,
        "desert-warden-agent-wing-02",
        [{ item_id: 1001, variant_id: 0, quantity: 4 }],
        [{ item_id: 1101, variant_id: 0, quantity: 50 }],
        32,
      )?.command,
    ).toEqual({
      ProposeTrade: {
        partner_actor_id: "desert-warden-agent-wing-02",
        offer: [{ item_id: 1001, variant_id: 0, quantity: 4 }],
        request: [{ item_id: 1101, variant_id: 0, quantity: 50 }],
      },
    });
    expect(enqueueAuthorityAcceptTradeCommand(queue, 1, 33)?.command).toEqual({
      AcceptTrade: { proposal_id: 1 },
    });
    expect(enqueueAuthorityDeclineTradeCommand(queue, 1, 34)?.command).toEqual({
      DeclineTrade: { proposal_id: 1 },
    });
    expect(queue.totalByKind).toMatchObject({
      StoreToExchange: 1,
      RetrieveFromExchange: 1,
      ProposeTrade: 1,
      AcceptTrade: 1,
      DeclineTrade: 1,
    });
    expect(queue.totalByKind.EnterTransition).toBe(0);
    // Validation: non-positive quantity, empty partner, non-positive proposal id rejected.
    expect(enqueueAuthorityStoreToExchangeCommand(queue, 2001, 0, 0, 35)).toBeNull();
    expect(enqueueAuthorityProposeTradeCommand(queue, "   ", [], [], 36)).toBeNull();
    expect(enqueueAuthorityAcceptTradeCommand(queue, 0, 37)).toBeNull();
    const missingVariant = [{ item_id: 1001, quantity: 1 } as unknown as ExchangeTradeItem];
    expect(enqueueAuthorityProposeTradeCommand(queue, "desert-warden-agent-wing-02", missingVariant, [], 38)).toBeNull();
    expect(
      enqueueAuthorityProposeTradeCommand(
        queue,
        "desert-warden-agent-wing-02",
        [{ item_id: 1001, variant_id: -1, quantity: 1 }],
        [],
        39,
      ),
    ).toBeNull();
  });

  it("drops stale pending commands without rewriting command history", () => {
    const queue = createAuthorityCommandQueue();
    enqueueAuthorityMoveCommand(queue, 1, 0, 2, 1);
    enqueueAuthorityTransitionCommand(queue, "test-entry", 2);

    expect(clearAuthorityCommandQueue(queue)).toBe(2);
    expect(queue.pending).toEqual([]);
    expect(queue.nextCommandId).toBe(3);
    expect(queue.totalQueued).toBe(2);
  });

  it("preserves an unconfirmed handoff envelope and lets its late exact receipt settle it without touching later work", () => {
    const queue = createAuthorityCommandQueue();
    const first = enqueueAuthorityMoveCommand(queue, 1, 0, 2, 1)!;
    const second = enqueueAuthorityTransitionCommand(queue, "test-entry", 2)!;
    queue.pending.shift();
    queue.inFlight = first;

    deferInFlightAuthorityCommand(queue);
    expect(queue.pending.map((envelope) => envelope.command_id)).toEqual([first.command_id, second.command_id]);
    expect(settleAuthorityCommand(queue, first.command_id)).toBe(true);
    expect(queue.pending.map((envelope) => envelope.command_id)).toEqual([second.command_id]);
    expect(settleAuthorityCommand(queue, first.command_id)).toBe(false);
  });

  it("derives monotonic issued ticks from runtime time and fixture tick", () => {
    expect(authorityIssuedAtTick(0, 20, 24)).toBe(24);
    expect(authorityIssuedAtTick(1600, 20, 24)).toBe(32);
    expect(authorityIssuedAtTick(1600, 0, 50)).toBe(50);
  });

  it("derives issued ticks from the latest authoritative snapshot receipt", () => {
    expect(authorityIssuedAtServerTick({
      worldTimeMs: 1_250,
      serverAuthority: {
        snapshotTick: 80,
        lastSnapshotReceivedAtMs: 1_000,
      },
    }, 20, 1)).toBe(85);
  });

  it("falls back to local runtime time before any authoritative snapshot", () => {
    expect(authorityIssuedAtServerTick({
      worldTimeMs: 1_600,
      serverAuthority: {
        snapshotTick: 0,
        lastSnapshotReceivedAtMs: null,
      },
    }, 20, 24)).toBe(32);
  });

  it("uses the scheduled command time for queued move timestamps", () => {
    expect(authorityIssuedAtServerTick({
      worldTimeMs: 1_300,
      serverAuthority: {
        snapshotTick: 80,
        lastSnapshotReceivedAtMs: 1_000,
      },
    }, 20, 1, 1_100)).toBe(82);
  });

  it("keeps scheduled move timestamps aligned with authority ticks", () => {
    const intervalMs = authorityMoveCommandIntervalMs(30);
    const tickMs = 1000 / 30;
    const durationTicks = 2;
    let commandWorldTimeMs = 1_000;
    let previousTick = 79;
    const duplicates: number[] = [];
    for (let index = 0; index < 360; index += 1) {
      const issuedTick = authorityIssuedAtServerTick({
        worldTimeMs: commandWorldTimeMs,
        serverAuthority: {
          snapshotTick: 80,
          lastSnapshotReceivedAtMs: 1_000,
        },
      }, 30, 1, commandWorldTimeMs);
      if (issuedTick <= previousTick) duplicates.push(index);
      previousTick = issuedTick;
      commandWorldTimeMs += intervalMs;
    }

    expect(intervalMs).toBeCloseTo(tickMs * durationTicks, 8);
    expect(duplicates).toEqual([]);
  });
  it("builds bank, skill-backup, and corpse-credit commands without truncating ids", () => {
    const queue = createAuthorityCommandQueue(7, 11);
    const longId = `${"a".repeat(64)}.crafted`;
    expect(enqueueAuthorityBankStoreItemCommand(queue, longId, 3, 20)?.command).toEqual({ BankStoreItem: { source_stack_id: longId, quantity: 3 } });
    expect(enqueueAuthorityBankRetrieveItemCommand(queue, longId, 2, 21)?.command).toEqual({ BankRetrieveItem: { bank_stack_id: longId, quantity: 2 } });
    expect(enqueueAuthorityBankDepositCreditsCommand(queue, 1000, 22)?.command).toEqual({ BankDepositCredits: { amount: 1000 } });
    expect(enqueueAuthorityBankWithdrawCreditsCommand(queue, 1000, 23)?.command).toEqual({ BankWithdrawCredits: { amount: 1000 } });
    expect(enqueueAuthorityCloneSaveSkillBackupCommand(queue, 24)?.command).toEqual({ CloneSaveSkillBackup: {} });
    expect(enqueueAuthorityCorpseTakeCreditsCommand(queue, longId, 25)?.command).toEqual({ CorpseTakeCredits: { corpse_id: longId } });
    expect(authorityCommandKind({ BankStoreItem: { source_stack_id: longId, quantity: 1 } })).toBe("BankStoreItem");
    expect(enqueueAuthorityBankDepositCreditsCommand(queue, 0, 26)).toBeNull();
  });
});
