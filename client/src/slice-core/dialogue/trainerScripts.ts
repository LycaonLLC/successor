import type { ProfessionId } from "../progressionSystem";
import {
  DENY_RANGE,
  holdsAllOwnedOrExchangeItems,
  professionLearned,
  STARTER_TOOL_ITEM_IDS,
  skillBoxTrained,
  teachListFor,
  teachOptionLabel,
  visibleTeachListFor,
  type DialogueCtx,
  type DialogueNode,
  type DialogueNpc,
  type DialogueOption,
  type DialogueTree,
  type DialogueVoice,
} from "./dialogueTree";
import { STARTER_TOOL_CONTRACT_LIVE, STARTER_TOOL_PENDING_NOTE } from "./starterToolLeaf";

/**
 * Trainer scripts — the first dialogue-tree content (trainer-conversation pattern).
 *
 * Five personas, one per trainable profession; the crafter is the richest
 * (teach + tool recovery + career goals). Persona selection: explicit actor
 * pins first, then the single profession an NPC teaches, then the crafter
 * bench-generalist. Voice: in-world, terse, dry — no dev copy, no cheer.
 *
 * Every command leaf names a REAL authority command; deny truth stays with
 * the server receipt. Career-goal copy quotes the sim's respec contract
 * (drops boxes outside the goal, 500 CR + 100/box, XP kept, primary weapon
 * swap) — if the sim's goal catalog changes, this content follows it.
 */

// ── Career goals (sim catalog: authority_career_goal_template) ────────────

interface CareerGoalContent {
  id: string;
  label: string;
  /** Honest composition one-liner (mirrors the sim's target groups). */
  scope: string;
  weapon: string;
}

const CAREER_GOALS: readonly CareerGoalContent[] = [
  { id: "rifle_utility", label: "Rifle Utility", scope: "rifle line, full medic, full scout, fieldcraft", weapon: "rifle" },
  { id: "ranged_specialist", label: "Ranged Specialist", scope: "full marksman, full scout, medic response", weapon: "rifle" },
  { id: "melee_specialist", label: "Melee Specialist", scope: "full brawler, scout mobility, full medic", weapon: "vibrosword" },
  { id: "rifle_quartermaster", label: "Rifle Quartermaster", scope: "full craftsman, full medic, rifle and fieldcraft", weapon: "rifle" },
];

// ── Shared option builders ─────────────────────────────────────────────────

const rangeGate = (ctx: DialogueCtx): string | null => (ctx.npc.inRange ? null : DENY_RANGE);

function farewellOption(label: string): DialogueOption {
  return { id: "farewell", label, action: { kind: "end" } };
}

function backOption(): DialogueOption {
  return { id: "back", label: "Back.", action: { kind: "goto", nodeId: "entry" } };
}

/** Dynamic teach node — the earlier sandbox design "what can you teach me" beat. */
function teachNode(emptyLine: string, listLine: string): DialogueNode {
  return {
    id: "teach",
    line: (ctx) => {
      const allEntries = teachListFor(ctx);
      if (allEntries.length === 0) return emptyLine;
      return visibleTeachListFor(ctx).length === 0
        ? "Nothing your current experience can buy. The full ledger shows what comes next."
        : listLine;
    },
    options: (ctx) => {
      const entries = visibleTeachListFor(ctx);
      const multiProfession = new Set(entries.map((entry) => entry.professionId)).size > 1
        || ctx.npc.professionIds.length > 1;
      const options: DialogueOption[] = entries.map((entry) => ({
        id: `train:${entry.node.id}`,
        label: teachOptionLabel(entry, multiProfession),
        gate: () => entry.reason,
        action: { kind: "train", skillBoxId: entry.node.id },
      }));
      options.push({
        id: "ledger",
        label: "Show me the full ledger.",
        action: { kind: "openWindow", windowId: "skills" },
      });
      options.push(backOption());
      return options;
    },
  };
}

function aboutNode(line: string): DialogueNode {
  return { id: "about", line, options: [backOption()] };
}

// ── Persona definitions ────────────────────────────────────────────────────

interface PersonaGreetings {
  stranger: string;
  learned: string;
  master: string;
}

function greetingLine(ctx: DialogueCtx, professionId: ProfessionId, greetings: PersonaGreetings): string {
  if (skillBoxTrained(ctx.state, `${professionId}-master`)) return greetings.master;
  if (professionLearned(ctx.state, professionId)) return greetings.learned;
  return greetings.stranger;
}

function voiceFor(persona: {
  trainAck: string;
  trainDeny: string;
  careerAck: string;
  careerDeny: string;
  toolAck: string;
  toolDeny: string;
}): DialogueVoice {
  return {
    trainAck: (boxLabel) => persona.trainAck.replaceAll("{box}", boxLabel),
    trainDeny: (reason) => persona.trainDeny.replaceAll("{reason}", reason),
    careerAck: (goalLabel) => persona.careerAck.replaceAll("{goal}", goalLabel),
    careerDeny: (reason) => persona.careerDeny.replaceAll("{reason}", reason),
    toolAck: () => persona.toolAck,
    toolDeny: (reason) => persona.toolDeny.replaceAll("{reason}", reason),
  };
}

// ── Craftsman — the bench boss (richest: teach + tools + career) ──────────

function craftsmanTree(): DialogueTree {
  const holdsBenchKit = (ctx: DialogueCtx): boolean => holdsAllOwnedOrExchangeItems(ctx, STARTER_TOOL_ITEM_IDS);
  const entry: DialogueNode = {
    id: "entry",
    line: (ctx) => {
      if (skillBoxTrained(ctx.state, "craftsman-master")) {
        return "Master's hands at my bench. Nothing left to chalk for you — doesn't mean I stopped working.";
      }
      if (professionLearned(ctx.state, "craftsman") && !holdsBenchKit(ctx)) {
        return "Working the trade with empty hands? That's a problem I can fix. Speak up.";
      }
      if (professionLearned(ctx.state, "craftsman")) {
        return "Back again. The bench missed you about as much as the war did. What do you need?";
      }
      return "You're kicking dust on my bench. State your business or buy a tool.";
    },
    options: [
      { id: "teach", label: "What can you teach me?", action: { kind: "goto", nodeId: "teach" } },
      { id: "field-start", label: "How do I get moving?", action: { kind: "goto", nodeId: "field-start" } },
      { id: "tools", label: "I need tools.", action: { kind: "goto", nodeId: "tools" } },
      { id: "career", label: "Set my course.", action: { kind: "goto", nodeId: "career" } },
      { id: "about", label: "Who are you?", action: { kind: "goto", nodeId: "about" } },
      farewellOption("Farewell."),
    ],
  };

  const tools: DialogueNode = {
    id: "tools",
    line: (ctx) => (holdsBenchKit(ctx)
      ? "You're already carrying the full bench kit. Lose it in the sand, then we'll talk."
      : "Bench work starts with a multitool and mineral scanner. The camp keeps one starter set per worker."),
    options: (ctx) => {
      const options: DialogueOption[] = [];
      if (!holdsBenchKit(ctx)) {
        options.push({
          id: "starter-tool",
          label: "Take the spare tool kit.",
          gate: (ctx) => (STARTER_TOOL_CONTRACT_LIVE ? rangeGate(ctx) : STARTER_TOOL_PENDING_NOTE),
          action: { kind: "starterTool" },
        });
      }
      options.push(backOption());
      return options;
    },
  };

  const fieldStart: DialogueNode = {
    id: "field-start",
    line: "Your first trade is a point spend, not a destiny. Use the kit you woke with, then come back here whenever you want to unlearn it or chalk a different novice box.",
    options: [
      { id: "field-resources", label: "How do I gather resources?", action: { kind: "goto", nodeId: "field-resources" } },
      { id: "field-hunt", label: "How do I hunt and make camp?", action: { kind: "goto", nodeId: "field-hunt" } },
      { id: "field-craft", label: "How do tools and crafting fit together?", action: { kind: "goto", nodeId: "field-craft" } },
      backOption(),
    ],
  };

  const fieldResources: DialogueNode = {
    id: "field-resources",
    line: "Anyone can hand-sample exposed ground for a small pull. A Craftsman novice carrying the matching survey tool can read concentrations before committing an extractor. Sampling works without the trade; Craftsman training is what turns it into Craftsman experience.",
    options: [{ id: "field-back", label: "Back to the field notes.", action: { kind: "goto", nodeId: "field-start" } }],
  };

  const fieldHunt: DialogueNode = {
    id: "field-hunt",
    line: "Anyone can fight barehanded and harvest a downed creature. Bone and hide are your first shelter: with Scout Novice, assemble a Camp Kit by hand from 24 bone and 36 hide. Place it for a five-by-five shelter. Leave it unattended for ten minutes and the camp comes down.",
    options: [{ id: "field-back", label: "Back to the field notes.", action: { kind: "goto", nodeId: "field-start" } }],
  };

  const fieldCraft: DialogueNode = {
    id: "field-craft",
    line: "Open the crafting ledger and read the station, skill, and material lines before you travel. If you are missing either starter tool, I can issue the Field Multitool and Mineral Survey Tool here. Chemical, gas, and water survey tools are crafted.",
    options: [{ id: "field-back", label: "Back to the field notes.", action: { kind: "goto", nodeId: "field-start" } }],
  };

  const career: DialogueNode = {
    id: "career",
    line: "A course keeps your points from sprawling. Pick one and I cut everything that doesn't serve it. Costs credits. XP stays yours.",
    options: [
      ...CAREER_GOALS.map((goal): DialogueOption => ({
        id: `career:${goal.id}`,
        label: `${goal.label}.`,
        action: { kind: "goto", nodeId: `career-${goal.id}` },
      })),
      backOption(),
    ],
  };

  const careerConfirms: DialogueNode[] = CAREER_GOALS.map((goal) => ({
    id: `career-${goal.id}`,
    line: `${goal.label} — ${goal.scope}. I drop every box outside that course: 500 credits, plus 100 a box. Your primary becomes the ${goal.weapon}. Say it plain.`,
    options: [
      { id: "confirm", label: "Do it.", gate: rangeGate, action: { kind: "careerGoal", goalId: goal.id } },
      { id: "cancel", label: "Never mind.", action: { kind: "goto", nodeId: "career" } },
    ],
  }));

  const nodes: Record<string, DialogueNode> = {
    entry,
    teach: teachNode(
      "You've cleared my slate. Go wear it out.",
      "Slate's chalked. Point at what you want.",
    ),
    "field-start": fieldStart,
    "field-resources": fieldResources,
    "field-hunt": fieldHunt,
    "field-craft": fieldCraft,
    tools,
    career,
    about: aboutNode(
      "Quartermaster before the wire came down. Now I keep this camp's iron moving — survey, sample, bench, repeat. You want the trade, I'll chalk it.",
    ),
  };
  for (const confirm of careerConfirms) nodes[confirm.id] = confirm;

  return {
    id: "trainer-craftsman",
    entry: () => "entry",
    nodes,
    voice: voiceFor({
      trainAck: "{box}. Chalked and yours. Don't make me re-teach it.",
      trainDeny: "Bench says no — {reason}.",
      careerAck: "{goal} it is. Dead weight's off your ledger.",
      careerDeny: "No cut today — {reason}.",
      toolAck: "Multitool and mineral scanner, camp stock. Bring them back sharp.",
      toolDeny: "Stores won't release it — {reason}.",
    }),
  };
}

// ── Marksman — the line-sergeant ───────────────────────────────────────────

function marksmanTree(): DialogueTree {
  return simplePersonaTree("trainer-marksman", "marksman", {
    greetings: {
      stranger: "Eyes up. You here to learn the rifle, or to waste my daylight?",
      learned: "Ammunition's cheap. Discipline isn't. What do you need?",
      master: "Nothing left in my locker for you, Master. Keep the line honest.",
    },
    teachEmpty: "You've shot the whole syllabus. Go hold a wire somewhere.",
    teachList: "Here's the course of fire. Pick your lane.",
    about: "Held the north wire through two dry seasons. The rifle kept me honest — it'll do the same for you.",
    voice: {
      trainAck: "{box}. Logged. Now go put rounds where they belong.",
      trainDeny: "Denied — {reason}. The range doesn't argue.",
      careerAck: "{goal}. Square your kit.",
      careerDeny: "Not today — {reason}.",
      toolAck: "Kit issued. Sign nothing, lose nothing.",
      toolDeny: "Stores are closed — {reason}.",
    },
  });
}

// ── Medic — the field surgeon ──────────────────────────────────────────────

function medicTree(): DialogueTree {
  return simplePersonaTree("trainer-medic", "medic", {
    greetings: {
      stranger: "If you're bleeding, kneel. If not, talk fast.",
      learned: "Still upright. That's either my work or your luck.",
      master: "Master Medic. Try to keep them breathing longer than I did.",
    },
    teachEmpty: "You know everything I know. Frightening.",
    teachList: "This is what I can put in your hands without a corpse to practice on.",
    about: "I patched troopers before this camp had walls. The vat brings them back; I keep them from needing it.",
    voice: {
      trainAck: "{box}. Learned. First one you save pays for the lesson.",
      trainDeny: "Can't sign that off — {reason}.",
      careerAck: "{goal}. Triage your own ledger for once.",
      careerDeny: "Refused — {reason}.",
      toolAck: "Kit's yours. Keep it cleaner than your record.",
      toolDeny: "Supply says no — {reason}.",
    },
  });
}

// ── Scout — the ranger ─────────────────────────────────────────────────────

function scoutTree(): DialogueTree {
  return simplePersonaTree("trainer-scout", "scout", {
    greetings: {
      stranger: "You walk loud. Sit. Tell me what you're after.",
      learned: "The desert let you back. Good sign.",
      master: "Master Scout. The ground reads you now.",
    },
    teachEmpty: "Nothing left on my side. The rest you learn by walking.",
    teachList: "What the ground taught me, I can teach you.",
    about: "I map water, bone, and the ways between. The camp eats because somebody walks first.",
    voice: {
      trainAck: "{box}. It's in your feet now.",
      trainDeny: "The ground says no — {reason}.",
      careerAck: "{goal}. Travel lighter.",
      careerDeny: "Not yet — {reason}.",
      toolAck: "Take it. Water's on you.",
      toolDeny: "No issue — {reason}.",
    },
  });
}

// ── Brawler — the pit fighter ──────────────────────────────────────────────

function brawlerTree(): DialogueTree {
  return simplePersonaTree("trainer-brawler", "brawler", {
    greetings: {
      stranger: "Hands. Show me. Soft — we can fix that.",
      learned: "Knuckles healed? Good. Back to work.",
      master: "Master Brawler. Save some teeth for the rest of us.",
    },
    teachEmpty: "You've taken everything I've got. Literally.",
    teachList: "Step in. I'll show you what your frame can carry.",
    about: "Pit circuit, before the Troopers signed me to hold their close line. Blades are arithmetic — I teach arithmetic.",
    voice: {
      trainAck: "{box}. Felt right, didn't it.",
      trainDeny: "Stop — {reason}. Form first.",
      careerAck: "{goal}. Now commit to it.",
      careerDeny: "No — {reason}.",
      toolAck: "Take it. Swing like you mean it.",
      toolDeny: "Rack's locked — {reason}.",
    },
  });
}

interface SimplePersonaContent {
  greetings: PersonaGreetings;
  teachEmpty: string;
  teachList: string;
  about: string;
  voice: Parameters<typeof voiceFor>[0];
}

/** Teach + small talk + farewell — the non-crafter persona shape. */
function simplePersonaTree(treeId: string, professionId: ProfessionId, content: SimplePersonaContent): DialogueTree {
  return {
    id: treeId,
    entry: () => "entry",
    nodes: {
      entry: {
        id: "entry",
        line: (ctx) => greetingLine(ctx, professionId, content.greetings),
        options: [
          { id: "teach", label: "What can you teach me?", action: { kind: "goto", nodeId: "teach" } },
          { id: "about", label: "Who are you?", action: { kind: "goto", nodeId: "about" } },
          farewellOption("Farewell."),
        ],
      },
      teach: teachNode(content.teachEmpty, content.teachList),
      about: aboutNode(content.about),
    },
    voice: voiceFor(content.voice),
  };
}

// ── Persona selection ──────────────────────────────────────────────────────

const TREE_BY_PROFESSION: Record<string, () => DialogueTree> = {
  craftsman: craftsmanTree,
  marksman: marksmanTree,
  medic: medicTree,
  scout: scoutTree,
  brawler: brawlerTree,
};

/** Explicit NPC pins — fixture personalities that outrank profession routing. */
const TREE_BY_ACTOR_ID: Record<string, () => DialogueTree> = {
  // The open-desert bootstrap generalist owns the bench: crafter persona,
  // teach list spans every profession it teaches (craftsman/marksman/medic).
  "camp-trainer": craftsmanTree,
};

const treeCache = new Map<string, DialogueTree>();

/**
 * Script for a trainer NPC: actor pin → single taught profession → crafter
 * bench-generalist. Trees are static — cache per tree id.
 */
export function trainerDialogueTree(npc: DialogueNpc): DialogueTree {
  const build = TREE_BY_ACTOR_ID[npc.actorId]
    ?? (npc.professionIds.length === 1 ? TREE_BY_PROFESSION[npc.professionIds[0]!] : undefined)
    ?? craftsmanTree;
  const probe = build();
  const cached = treeCache.get(probe.id);
  if (cached) return cached;
  treeCache.set(probe.id, probe);
  return probe;
}
