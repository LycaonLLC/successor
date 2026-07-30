/**
 * Credit chip redemption — a chip is PHYSICAL currency in the pack whose
 * quantity is its face value. `/redeem` banks the richest carried chip into the
 * credit balance with datapad prose; a second `/redeem` after the server
 * consumes it honestly reports an empty pack (the chip really left, not just an
 * optimistic echo).
 */
export default async function creditChip({ session, actorId, grant, check }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "GateChipper" });
  await tui.expect(/Signal locked/);

  await grant(id, "creditChip", 3500);
  await tui.idle(900);

  const redeem = await tui.say("/redeem", /credit chip into your datapad/i, { timeoutMs: 12_000 });
  check("redeem speaks the datapad banking prose", /credit chip into your datapad/i.test(redeem.line));
  check("redeem names the chip's 3,500-credit value", /3[,.]?500/.test(redeem.line));

  // Let the server consume the chip + stream the emptied pack back, then a
  // second redeem must find nothing — proof the chip was truly banked.
  await tui.idle(2_500);
  const empty = await tui.say("/redeem", /no credit chip/i, { timeoutMs: 8_000 });
  check("a second redeem honestly reports no chip left", /no credit chip/i.test(empty.line));
}
