# Metrics and offset primitives

## Exchange metrics law

Exchange metrics are observability. They must stay outside `SliceAuthorityState`, out of `export_state_blob`, and out of `stable_state_hash_hex`. A replay with the metrics store present or absent must produce the same authority state hash and the same command outcomes.

The exchange store records deterministic tick-derived facts only:

- open exchange: first accepted combat queue entry or first combat event between an actor pair
- close exchange: death/downed transition, `/peace`, actor leash/removal, or inactivity timeout ticks
- retained history: last 256 closed exchanges in ring order
- aggregation: `BTreeMap`/sorted iteration only; no wall-clock reads

## Atomic tuning primitives already in use

| Primitive | Attachment point | Current shape |
|---|---|---|
| Melee speed points | `ActorProfessionState::brawler_melee_speed_points()` feeds `melee_attack_interval_ms()` and roll/melee cooldown ticks | Brawler novice grants the head start; attack-speed boxes add `BRAWLER_MELEE_SPEED_POINTS_PER_BOX`; `BRAWLER_MELEE_SPEED_POINTS_CAP` preserves the 1000ms master floor |
| Damage milli / scalar points | Weapon/ammo profiles, crafted Slugthrower multipliers, aimed-shot numerator/denominator, medical/crafting line milli caps | Damage changes should add points or table rows into the existing weapon/profile/crafting math, not branch per recipe or per enemy |
| Block permille / milli chance | `BRAWLER_RANGED_BLOCK_CHANCE_MILLI_PER_BOX` and cap feed ranged-block rolls; personal-shield block remains its own shield primitive | New defensive tuning should add block/dodge/shield points to existing chance primitives |
| XP and skill costs | `AuthoritySkillBoxDefinition.xp_required`, track XP maps, `SKILL_POINT_COST_*`, field-supply XP track routing | New progression tuning should add boxes/tracks/cost rows, not one-off command gates |
| Movement speed points | role/profession movement multipliers and scout/brawler movement tracks feed existing movement distance math | New movement bonuses should enter these multipliers, not bypass `movement_speed_multiplier_milli_for_actor` |

Rule: new tuning means new points into existing primitives. Do not add special-case systems when a point, cap, range row, or table weight can express the balance.

## Novice melee boof

Brawler novice now carries a small melee-cadence head start: `+10` melee speed points before attack-speed boxes. The master cap/floor stays unchanged at `BRAWLER_MELEE_SPEED_POINTS_CAP` and `MELEE_MIN_ATTACK_INTERVAL_MS`.

Balance head: a stock 5000ms melee swing drops into the mid-4.5s novice band while master Brawler remains clamped to 1000ms. Future cadence tuning should move this head-start const or the existing per-box/cap consts, not add per-weapon novice exceptions.
