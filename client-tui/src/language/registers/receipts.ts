/**
 * RECEIPTS register — the wire answering back.
 *
 * Accepted commands mostly stay quiet (the act itself will speak through
 * events); rejections ALWAYS speak, stamped with the shared reason
 * vocabulary plus one clause of prose where the reason deserves it.
 */

import { REASON_CLAUSE, reasonCopy } from "../copy";

export interface ReceiptInputs {
  commandKind: string | undefined;
  accepted: boolean;
  reasonCode: string | undefined;
}

/** Kinds whose ACCEPT is worth a line (most accepts are silent). */
const ACCEPT_LINE: Record<string, string> = {
  SurveyResource: "The scanner spins up and sweeps.",
  SampleResource: "You kneel and work a small sample loose by hand.",
  CloneRespawn: "The clone bay accepts your pattern.",
  Peace: "You ease off the trigger and stand down.",
  ReloadWeapon: "Fresh magazine — you rack it home.",
  UseTravelTicket: "The terminal chews your ticket and clears you through.",
  PurchaseTravelTicket: "Ticket bought and stamped.",
  HarvestCorpse: "You strip useful hide, meat, and bone from the corpse.",
  PlaceExtractor: "You drive the extractor's feet into the ground — deployed.",
  CrankExtractor: "You put your back into the crank; the drum starts to turn.",
  StopCrank: "You let the crank wind down.",
  InsertBattery: "The battery seats with a click; the rig hums off your hands.",
  CollectExtractor: "You empty the hopper into your pack.",
  DestroyExtractor: "You break the rig down and shoulder it — packed up.",
  StoreToExchange: "The exchange clerk takes your goods and stamps the ledger.",
  RetrieveFromExchange: "Retrieved from the exchange ledger into your pack.",
  ProposeTrade: "Your offer goes out.",
  AcceptTrade: "Your side of the table locks.",
  DeclineTrade: "You wave the offer off.",
  AddTradeItem: "",
  RemoveTradeItem: "",
  SetTradeCoin: "",
  ConfirmTrade: "Your hand comes down.",
  CraftBegin: "You clear the bench and lay the frame out.",
  CraftAssignSlot: "",
  CraftClearSlot: "",
  CraftAssemble: "You bring the assembly together and hold your breath…",
  CraftExperiment: "The experiment takes.",
  CraftFinalizePrototype: "The work comes off the bench into your pack.",
  CraftFinalizePractice: "Practice is complete. No item leaves the bench.",
  FactoryManufacture: "The factory stamps one run from the draft.",
  CraftDraftSchematic: "You commit the work to a factory draft — filed to your datapad.",
  CraftCancel: "You sweep the bench clear.",
  RequestStarterTool: "The requisition line coughs up a toolkit.",
  GroupInvite: "You wave them over — the offer stands thirty seconds.",
  GroupAccept: "You fall in together.",
  GroupDecline: "You beg off.",
  GroupLeave: "You peel away from the crew.",
  GroupDisband: "You break the crew up.",
  GroupKick: "You cut them loose.",
  ToggleDoor: "",
  DuelChallenge: "You throw down the glove — the challenge stands thirty seconds.",
  DuelAccept: "Blades up — the duel is on.",
  DuelDecline: "You wave the duel off.",
  DuelYield: "You lower your weapon — the duel ends with honor.",
  PlaceCamp: "You break out the kit and pitch camp — canvas up, ground claimed.",
  PackUpCamp: "You strike the camp — nothing returns to the pack.",
  GeneSample: "The sampler chews a wild cutting — genome banked as seed.",
  SpliceBegin: "You spread the parent lines across the gene bench.",
  SpliceAssignSlot: "",
  SpliceClearSlot: "",
  SpliceChooseAllele: "",
  SpliceAssemble: "The splice takes — a new line holds together.",
  SpliceExperimentLocus: "The locus bends.",
  SpliceMint: "You mint the cultivar — seed stock, named and yours.",
  SpliceCancel: "You clear the gene bench.",
  EnterTransition: "",
}; // "" = deliberate silence

export function composeReceiptLine(receipt: ReceiptInputs): { text: string; reject: boolean } | null {
  if (receipt.accepted) {
    const line = receipt.commandKind ? ACCEPT_LINE[receipt.commandKind] : undefined;
    if (line === undefined || line === "") return null;
    return { text: line, reject: false };
  }
  const code = receipt.reasonCode ?? "rejected";
  const stamp = reasonCopy(code);
  const clause = REASON_CLAUSE[code];
  const kind = receipt.commandKind ? `${receipt.commandKind.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()} ` : "";
  return {
    text: clause ? `${kind}DENIED — ${stamp}: ${clause}.` : `${kind}DENIED — ${stamp}.`,
    reject: true,
  };
}
