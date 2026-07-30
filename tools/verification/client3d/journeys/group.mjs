// Journey: group — two browsers. Alpha invites Beta, Beta accepts, and both
// sessions observe a two-member group. Asserts the ORACLE (authoritative
// groupViews) AND the FE: Beta's invite toast (.sc3d-group-invite) while the
// invite pends, member rails (.sc3d-group-rail) on both clients once formed.
// Money shots: invite pending, group formed on both clients.
function membersOf(gv) {
  if (!gv) return [];
  if (Array.isArray(gv.members) && gv.members.length) return gv.members.map((m) => m.actorId ?? m.id ?? m);
  return gv.group?.memberActorIds ?? [];
}

export default {
  id: "group",
  title: "Group two-browser (invite/accept/frames)",
  timeoutMs: 120000,
  characters: [
    { role: "alpha", id: "h3d-group-alpha", name: "GroupAlpha", x: 512, y: 512, initialProfessionId: "brawler" },
    { role: "beta", id: "h3d-group-beta", name: "GroupBeta", x: 513, y: 512, initialProfessionId: "brawler" },
  ],
  async run(ctx) {
    const alpha = ctx.session("alpha");
    const beta = ctx.session("beta");
    await ctx.moneyShot("00-alpha", alpha);

    // Alpha invites Beta (28s countdown); Beta receives a pending invite.
    await alpha.slash("/group-invite h3d-group-beta");
    const invited = await alpha.waitProbeCall(
      () => alpha.oracle(),
      (o) => !!o.groupViews?.["h3d-group-beta"]?.pendingInvite || membersOf(o.groupViews?.["h3d-group-alpha"]).includes("h3d-group-beta"),
      { label: "beta has a pending invite", timeoutMs: 12000 },
    );
    ctx.note(`invite -> beta groupView ${JSON.stringify(invited.groupViews?.["h3d-group-beta"] ?? null).slice(0, 200)}`);
    // FE: the invited client renders the toast (fe-polish §1.29 — it used to
    // render NOTHING anywhere).
    await beta.waitDom(".sc3d-group-invite", { state: "visible", timeoutMs: 8000 });
    await ctx.moneyShot("01-invite-pending", beta);

    // Beta accepts → both sessions see a two-member group.
    await beta.slash("/group-accept");
    const formed = await beta.waitProbeCall(
      () => beta.oracle(),
      (o) => membersOf(o.groupViews?.["h3d-group-alpha"]).length >= 2 && membersOf(o.groupViews?.["h3d-group-beta"]).length >= 2,
      { label: "two-member group formed", timeoutMs: 12000 },
    );
    const aMembers = membersOf(formed.groupViews["h3d-group-alpha"]);
    const bMembers = membersOf(formed.groupViews["h3d-group-beta"]);
    ctx.note(`group formed alpha-view=${JSON.stringify(aMembers)} beta-view=${JSON.stringify(bMembers)}`);
    // FE: both clients render the member rail with the other's chip.
    await alpha.waitDom(".sc3d-group-rail .sc3d-group-chip", { state: "visible", timeoutMs: 8000 });
    await beta.waitDom(".sc3d-group-rail .sc3d-group-chip", { state: "visible", timeoutMs: 8000 });
    await ctx.moneyShot("02-group-alpha", alpha);
    await ctx.moneyShot("03-group-beta", beta);

    alpha.assert(aMembers.length >= 2, `alpha does not see a full group: ${JSON.stringify(aMembers)}`);
    beta.assert(bMembers.length >= 2, `beta does not see a full group: ${JSON.stringify(bMembers)}`);
    alpha.assert(aMembers.includes("h3d-group-alpha") && aMembers.includes("h3d-group-beta"), `group missing a member: ${JSON.stringify(aMembers)}`);
  },
};
