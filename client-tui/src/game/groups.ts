/**
 * /group — the party as terminal flows (§9.4, CLOSED at GroupsSimO landing).
 *
 * Command surface rides the generated group verbs (invite/accept/decline/
 * leave/disband/kick, honest reason codes). The VIEW streams as the
 * per-observer group channel (successor.authority-groups.v1) ingested into
 * PlayState at serverAuthority.group — vitals, area, leader, LINK-DEAD per
 * member. Member frames carry NO coordinates by design: precise position
 * reaches the roster only when the member's actor is in your AOI stream,
 * same as the 3D client (visibility law).
 */

import type { GameSession } from "./session";
import { windShort, windFor } from "./bearing";
import type { CommandLineOut } from "../commands";
import type { ServerAuthorityGroupViewState } from "@successor/client/src/slice-core/gameState";

/** The live per-observer group channel as ingested into PlayState. */
export type GroupView = ServerAuthorityGroupViewState;

/** Injected view source — the live binding reads serverAuthority.group. */
export type GroupViewSource = () => GroupView;

export function routeGroup(
  session: GameSession,
  groupView: GroupViewSource,
  args: readonly string[],
): CommandLineOut[] {
  const sub = (args[0] ?? "").toLowerCase();
  const usage = "Group: /group invite <who> · accept · decline · leave · disband · kick <who> — /group shows the roster.";

  if (sub === "" || sub === "status" || sub === "list") {
    return renderRoster(session, groupView());
  }

  if (sub === "invite" || sub === "kick") {
    const token = args.slice(1).join(" ").trim();
    if (!token) return [{ register: "system", text: `${sub === "invite" ? "Invite" : "Kick"} whom? /group ${sub} <name>` }];
    const target = resolveGroupTarget(session, token);
    if (!target) return [{ register: "reject", text: `No one in scope answers to «${token}».` }];
    return [wire(session, `/group-${sub} target_actor_id=${target.id}`)];
  }

  if (sub === "accept" || sub === "decline" || sub === "leave" || sub === "disband") {
    return [wire(session, `/group-${sub}`)];
  }

  return [{ register: "system", text: usage }];
}

/** Roster block: leader star, micro-gauges, bearing, LINK-DEAD state. */
export function renderRoster(session: GameSession, view: GroupView): CommandLineOut[] {
  const lines: CommandLineOut[] = [];
  if (view.pendingInvite) {
    const remaining = Math.max(0, view.pendingInvite.expiresTick - session.estimatedTick());
    const seconds = Math.ceil(remaining / session.slice.tickRateHz);
    lines.push({
      register: "world",
      text: `${view.pendingInvite.inviterName} wants you in their crew — /group accept or /group decline (${seconds}s).`,
    });
  }
  if (!view.group || view.members.length === 0) {
    if (lines.length === 0) lines.push({ register: "system", text: "You walk alone." });
    return lines;
  }
  const state = session.state;
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[meId];
  const px = me?.x ?? state.player.x;
  const py = me?.y ?? state.player.y;
  lines.push({ register: "help", text: `Your crew (${view.members.length}):` });
  for (const member of view.members) {
    const star = member.isLeader ? "★" : "·";
    const hp = member.maxVitals.health > 0 ? Math.round((member.vitals.health / member.maxVitals.health) * 100) : 0;
    const streamed = member.actorId === meId ? me : state.serverAuthority.actors[member.actorId];
    const where = member.actorId === meId
      ? "you"
      : member.areaId !== state.activeAreaId
        ? "another area"
        : streamed
          ? `${windShort(windFor(streamed.x - px, streamed.y - py))} ${Math.round(Math.hypot(streamed.x - px, streamed.y - py))}c`
          : "out of scope";
    const status = member.linkDead ? "  LINK-DEAD · reconnecting" : member.lifeState !== "alive" ? `  ${member.lifeState.toUpperCase()}` : "";
    lines.push({
      register: member.linkDead ? "receipt" : "system",
      text: `  ${star} ${member.name.padEnd(16)} H ${String(hp).padStart(3)}%  ${where}${status}`,
    });
  }
  return lines;
}

function wire(session: GameSession, line: string): CommandLineOut {
  const result = session.executeVerb(line);
  if (!result) return { register: "reject", text: `Nothing answers (${line}).` };
  const rejected = result.class === "authority" && result.data.queued === false;
  return { register: rejected ? "reject" : "receipt", text: result.text };
}

function resolveGroupTarget(session: GameSession, token: string): { id: string; label: string } | null {
  const needle = token.toLowerCase();
  for (const contact of session.tracker.contacts()) {
    if (contact.id.toLowerCase() === needle || contact.label.toLowerCase().includes(needle)) {
      return { id: contact.id, label: contact.label };
    }
  }
  return null;
}
