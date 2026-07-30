/**
 * /splice — the gene bench as terminal flows (BioECore tags 80-89).
 *
 * Fully drivable wire: sample wild landraces where you stand (seeds into
 * the pack), spread parents on the bench, assemble (empty allele choices
 * inherit by default), experiment, mint a named cultivar. Receipts + the
 * seed stacks are truth. The bench READOUT streams per-observer as
 * serverAuthority.spliceSession (BioECore a20036d, craftSession pattern)
 * and the latest scan as serverAuthority.genomeScan — structural twins
 * below until the canonical types export (groups precedent: one import
 * swap then).
 */

import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { resolveItem } from "./exchangeTrade";
import type { CommandLineOut } from "../commands";
import type { GameSession } from "./session";

// ── contract twins (BioECore a20036d) ───────────────────────────────────────

export interface SpliceSlotVM {
  slotIndex: number;
  kind: "parent" | "reagent";
  label: string;
  filled: boolean;
  itemId: number;
  variantId: number;
}

export interface SpliceLineVM {
  locus: number;
  label: string;
  baseMilli: number;
  valueMilli: number;
  capMilli: number;
  canRaise: boolean;
}

export interface GameSpliceSession {
  phase: "browse" | "slots" | "assembled";
  speciesId: number;
  speciesName: string;
  slots: SpliceSlotVM[];
  lines: SpliceLineVM[];
  assemblyQualityMilli: number;
  pointsTotal: number;
  pointsRemaining: number;
  canAssemble: boolean;
  tick: number;
}

export interface GenomeScanLocusVM {
  locus: number;
  label: string;
  expressMilli: number;
  heterozygous?: boolean;
  a1?: number;
  a2?: number;
}

export interface GameGenomeScan {
  itemId: number;
  variantId: number;
  speciesName: string;
  cultivarName: string;
  tier: "phenotype" | "hidden_presence" | "allele_values" | "full";
  fertile: boolean;
  loci: GenomeScanLocusVM[];
  mutationPotentialMilli?: number;
  generation?: number;
  tick: number;
}

export function spliceViewOf(state: PlayState): GameSpliceSession | null {
  return (state.serverAuthority as { spliceSession?: GameSpliceSession | null }).spliceSession ?? null;
}

export function genomeScanOf(state: PlayState): GameGenomeScan | null {
  return (state.serverAuthority as { genomeScan?: GameGenomeScan | null }).genomeScan ?? null;
}

const gauge = (value: number, cap: number): string => {
  const total = 8;
  const filled = cap > 0 ? Math.round((value / cap) * total) : 0;
  return `${"▰".repeat(Math.min(total, Math.max(0, filled)))}${"▱".repeat(total - Math.min(total, Math.max(0, filled)))}`;
};

/** The bench readout — the DEF-6 surface, craft-workbench register. */
export function spliceReadoutLines(view: GameSpliceSession): CommandLineOut[] {
  const lines: CommandLineOut[] = [
    { register: "help", text: `GENE BENCH — ${view.speciesName} · ${view.phase.toUpperCase()}` },
  ];
  for (const slot of view.slots) {
    const tag = slot.kind === "parent" ? `PARENT ${String.fromCharCode(65 + slot.slotIndex)}` : slot.label.toUpperCase();
    lines.push({
      register: "system",
      text: `  ${tag} — ${slot.filled ? "seated" : `empty   (/splice fill ${slot.slotIndex + 1} <seed>)`}`,
    });
  }
  for (const line of view.lines) {
    lines.push({
      register: "survey",
      text: `  ${line.locus}. ${line.label.padEnd(12)} ${line.valueMilli} / cap ${line.capMilli}  ${gauge(line.valueMilli, line.capMilli)}${line.canRaise ? "" : "  (at cap)"}`,
    });
  }
  if (view.phase === "assembled") {
    lines.push({
      register: "system",
      text: `  Assembly ${Math.round(view.assemblyQualityMilli / 10)}% · ${view.pointsRemaining}/${view.pointsTotal} points — /splice exp <locus> <pts> · /splice mint [name] · /splice cancel`,
    });
  } else if (view.canAssemble) {
    lines.push({ register: "system", text: "  Both parents seated — /splice assemble when ready." });
  }
  return lines;
}

/** The scan card — tiered reveal spoken honestly. */
export function genomeScanLines(scan: GameGenomeScan): CommandLineOut[] {
  const lines: CommandLineOut[] = [
    {
      register: "survey",
      text: `The scan resolves: «${scan.cultivarName}» ${scan.speciesName} — ${scan.fertile ? "fertile" : "STERILE"} · read at ${scan.tier.replace(/_/g, " ")}${scan.generation !== undefined ? ` · G${scan.generation}` : ""}.`,
    },
  ];
  for (const locus of scan.loci) {
    const alleles = locus.a1 !== undefined && locus.a2 !== undefined
      ? `  [${locus.a1}|${locus.a2}${locus.heterozygous ? " het" : ""}]`
      : locus.heterozygous !== undefined
        ? (locus.heterozygous ? "  [mixed]" : "  [true-breeding]")
        : "";
    lines.push({ register: "system", text: `  ${locus.label.padEnd(12)} ${locus.expressMilli}${alleles}` });
  }
  if (scan.mutationPotentialMilli !== undefined) {
    lines.push({ register: "receipt", text: `  mutation potential ${scan.mutationPotentialMilli}` });
  }
  return lines;
}

const SPECIES = ["ashgrain", "sunmelon", "cavemoss"] as const;

export function routeSplice(session: GameSession, args: readonly string[]): CommandLineOut[] {
  const sub = (args[0] ?? "").toLowerCase();
  const usage = "Splice: /splice sample <species> banks a wild genome as seed · begin <species> spreads the bench · fill <1|2> <seed> seats a parent · allele <locus> <a|b> <n> picks · assemble · exp <locus> <pts> · mint [name] · cancel.";

  if (sub === "" || sub === "status") {
    const view = spliceViewOf(session.state);
    if (view) return spliceReadoutLines(view);
    return [{ register: "system", text: usage }];
  }
  if (sub === "sample") {
    const species = (args[1] ?? "").toLowerCase();
    if (!SPECIES.includes(species as (typeof SPECIES)[number])) {
      return [{ register: "system", text: `Sample what? Known species: ${SPECIES.join(" · ")}.` }];
    }
    return [wire(session, `/gene-sample species=${species}`)];
  }
  if (sub === "begin") {
    const species = (args[1] ?? "").toLowerCase();
    if (!SPECIES.includes(species as (typeof SPECIES)[number])) {
      return [{ register: "system", text: `Begin with which species? ${SPECIES.join(" · ")}.` }];
    }
    return [wire(session, `/splice-begin species=${species}`)];
  }
  if (sub === "fill") {
    const slot = Number(args[1]);
    if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
      return [{ register: "system", text: "Slots run 1-6 (parents first) — /splice fill <slot> <seed|reagent>." }];
    }
    const token = args.slice(2).join(" ").trim();
    if (!token) return [{ register: "system", text: "Seat what? /splice fill <slot> <seed name or id>." }];
    // exclude stacks already seated on the bench: two same-name seed stacks
    // must fill as DISTINCT parents (the bench VM knows what's seated)
    const seated = new Set(
      (spliceViewOf(session.state)?.slots ?? [])
        .filter((benchSlot) => benchSlot.filled)
        .map((benchSlot) => `${benchSlot.itemId}:${benchSlot.variantId}`),
    );
    const resolved = resolveItem(
      session.state,
      token,
      (row) => session.isCarried(row.container) && !seated.has(`${row.itemId}:${row.variantId}`),
    );
    if (!resolved) return [{ register: "reject", text: `No carried stack answers to «${token}» (stacks already on the bench are skipped).` }];
    return [wire(session, `/splice-assign-slot slot_index=${slot - 1} container=${resolved.row.container} stack_id=${resolved.row.stackId} variant_id=${resolved.row.variantId}`)];
  }
  if (sub === "allele") {
    const locus = (args[1] ?? "").toLowerCase();
    const from = (args[2] ?? "").toLowerCase();
    const allele = args[3];
    if (!locus || (from !== "a" && from !== "b") || allele === undefined) {
      return [{ register: "system", text: "Pick like: /splice allele <locus> <a|b> <allele>." }];
    }
    return [wire(session, `/splice-choose-allele locus=${locus} from_parent=${from} allele=${allele}`)];
  }
  if (sub === "assemble") return [wire(session, "/splice-assemble")];
  if (sub === "exp") {
    const locus = (args[1] ?? "").toLowerCase();
    const points = Number(args[2]);
    if (!locus || !Number.isInteger(points) || points < 1) {
      return [{ register: "system", text: "Bend which locus? /splice exp <locus> <points>." }];
    }
    return [wire(session, `/splice-experiment-locus locus=${locus} points=${points}`)];
  }
  if (sub === "mint") {
    const name = args.slice(1).join(" ").trim();
    return [wire(session, name ? `/splice-mint cultivar_name=${name}` : "/splice-mint")];
  }
  if (sub === "cancel") return [wire(session, "/splice-cancel")];
  return [{ register: "system", text: usage }];
}

function wire(session: GameSession, line: string): CommandLineOut {
  const result = session.executeVerb(line);
  if (!result) return { register: "reject", text: "Nothing answers — this shard predates the gene bench." };
  const rejected = result.class === "authority" && result.data.queued === false;
  return { register: rejected ? "reject" : "receipt", text: result.text };
}
