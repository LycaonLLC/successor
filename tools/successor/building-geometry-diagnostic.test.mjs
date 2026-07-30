import test from "node:test";
import assert from "node:assert/strict";

import { diagnose, TOLERANCES } from "./building-geometry-diagnostic.mjs";

function sliceFixture(overrides = {}) {
  return {
    props: [{
      id: "facility",
      cell: { x: 10, y: 20 },
      size: { w: 2, h: 2 },
      rotation: 0,
      collisionBounds: [
        { id: "wall", xMilli: 100, yMilli: 200, wMilli: 500, hMilli: 100 },
      ],
      door: {
        blocker: { id: "door", xMilli: 800, yMilli: 200, wMilli: 100, hMilli: 100 },
      },
      enterable: {
        floorHeightM: 0.02,
        interiorBounds: [{ id: "room", xMilli: 200, yMilli: 400, wMilli: 400, hMilli: 400 }],
      },
      ...overrides,
    }],
  };
}

function authorityFixture({
  fine = [{ propId: "facility", left: 10_100, top: 20_200, right: 10_600, bottom: 20_300 }],
  doors = [{ propId: "facility", left: 10_800, top: 20_200, right: 10_900, bottom: 20_300, open: false }],
} = {}) {
  return {
    state: {
      fineCollisionBounds: fine,
      doorCollisionBounds: doors,
    },
  };
}

const literalClientHookFixture = {
  building: {
    propId: "facility",
    areaId: "open-desert-overworld",
    cell: { x: 10, y: 20 },
    size: { w: 2, h: 2 },
    rotation: 0,
    floorSurfaceY: 0.02,
    explicitInteriorBounds: true,
    interiorBounds: [{ id: "room", xMilli: 200, yMilli: 400, wMilli: 400, hMilli: 400 }],
    phase: "interior",
    dwell: 0,
    target: 1,
    fade: 1,
    doorOpen: false,
    doorSlideT: 0,
    doorInRevealSet: false,
    meshCounts: { floor: 5, reveal: 56, keep: 41, door: 1 },
    worldBounds: {
      floor: { min: { x: 10, y: -0.12, z: 20 }, max: { x: 12, y: 0.11, z: 22 } },
      reveal: { min: { x: 10, y: 0, z: 20 }, max: { x: 12, y: 5.2, z: 22 } },
      keep: { min: { x: 10, y: 0, z: 20 }, max: { x: 12, y: 5.4, z: 22 } },
      door: { min: { x: 10.8, y: 0, z: 20.2 }, max: { x: 10.9, y: 2.5, z: 20.3 } },
    },
  },
  pawn: {
    actorId: "player",
    rootPosition: { x: 10.3, y: 0.02, z: 20.5 },
    bodyMinY: 0.007,
    bodyBounds: {
      min: { x: 10.1, y: 0.007, z: 20.3 },
      max: { x: 10.5, y: 1.74, z: 20.7 },
    },
    shadowPlaneY: 0.035,
  },
};

function clientFixture() {
  return structuredClone(literalClientHookFixture);
}

function check(report, name) {
  return report.layers.client.checks.find((candidate) => candidate.name === name);
}

test("matches unordered Rust wall and door geometry exactly", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    authorityExport: authorityFixture(),
  });

  assert.equal(report.layers.authority.status, "pass");
  assert.equal(report.layers.authority.matches.length, 2);
  assert.deepEqual(report.layers.authority.missing, []);
  assert.deepEqual(report.layers.authority.extra, []);
});

test("carries authored primitive IDs into authority matches", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    authorityExport: authorityFixture(),
  });

  assert.deepEqual(
    report.layers.authority.matches.map((match) => match.primitiveId),
    ["wall", "door"],
  );
});

test("fails when Rust omits an authored wall", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    authorityExport: authorityFixture({ fine: [] }),
  });

  assert.equal(report.layers.authority.status, "fail");
  assert.equal(report.layers.authority.missing[0].id, "wall");
});

test("fails when Rust adds an unauthored blocker", () => {
  const extra = { propId: "facility", left: 11_000, top: 21_000, right: 11_100, bottom: 21_100 };
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    authorityExport: authorityFixture({
      fine: [
        { propId: "facility", left: 10_100, top: 20_200, right: 10_600, bottom: 20_300 },
        extra,
      ],
    }),
  });

  assert.equal(report.layers.authority.status, "fail");
  assert.equal(report.layers.authority.extra.length, 1);
});

test("reports malformed authority records as a failed layer", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    authorityExport: authorityFixture({ fine: [null] }),
  });

  assert.equal(report.layers.authority.status, "fail");
  assert.equal(report.layers.authority.missing[0].id, "wall");
  assert.deepEqual(report.layers.authority.extra, [{ malformed: true }]);
  assert.equal(report.overall.status, "fail");
});

test("retains and validates door geometry while the authority door is open", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    authorityExport: authorityFixture({
      doors: [{ propId: "facility", left: 10_800, top: 20_200, right: 10_900, bottom: 20_300, open: true }],
    }),
  });

  assert.equal(report.layers.authority.status, "pass");
  assert.equal(report.layers.authority.doorOpen, true);
  assert.equal(report.layers.authority.matches.at(-1).primitiveId, "door");
});

test("marks omitted optional layers as not provided", () => {
  const report = diagnose({ slice: sliceFixture(), propId: "facility" });

  assert.equal(report.layers.authority.status, "not_provided");
  assert.equal(report.layers.client.status, "not_provided");
  assert.equal(report.layers.movement.status, "not_provided");
  assert.equal(report.overall.status, "pass");
});

test("accepts a literal probe shaped like the real client hook", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    authorityExport: authorityFixture(),
    clientProbe: clientFixture(),
  });

  assert.equal(report.layers.client.status, "pass");
  assert.equal(report.overall.status, "pass");
  assert.equal(check(report, "propId").pass, true);
  assert.equal(check(report, "floorWorldBounds").pass, true);
});

test("requires building.propId rather than an invented identity field", () => {
  const probe = clientFixture();
  probe.building.propId = "wrong";
  probe.building.identity = "facility";
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    clientProbe: probe,
  });

  assert.equal(report.layers.client.status, "fail");
  assert.equal(check(report, "propId").pass, false);
});

test("treats rendered floor Box3 as an envelope around the canonical surface", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    clientProbe: clientFixture(),
  });

  assert.equal(check(report, "floorSurfaceInsideRenderedEnvelope").pass, true);
});

test("fails when the canonical floor is outside the rendered floor envelope", () => {
  const probe = clientFixture();
  probe.building.worldBounds.floor.min.y = 0.2;
  probe.building.worldBounds.floor.max.y = 0.3;
  const report = diagnose({ slice: sliceFixture(), propId: "facility", clientProbe: probe });

  assert.equal(report.layers.client.status, "fail");
  assert.equal(check(report, "floorSurfaceInsideRenderedEnvelope").pass, false);
});

test("uses separate strict root and authored-body grounding tolerances", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    clientProbe: clientFixture(),
  });

  assert.equal(TOLERANCES.rootFloorMeters, 0.002);
  assert.equal(TOLERANCES.bodyFloorMeters, 0.02);
  assert.equal(check(report, "rootGrounding").pass, true);
  assert.equal(check(report, "bodyGrounding").pass, true);
});

test("fails a root that is beyond strict floor tolerance", () => {
  const probe = clientFixture();
  probe.pawn.rootPosition.y = 0.02 + TOLERANCES.rootFloorMeters + 0.001;
  const report = diagnose({ slice: sliceFixture(), propId: "facility", clientProbe: probe });

  assert.equal(check(report, "rootGrounding").pass, false);
});

test("fails when a gameplay door enters the cutaway reveal set", () => {
  const probe = clientFixture();
  probe.building.doorInRevealSet = true;
  const report = diagnose({ slice: sliceFixture(), propId: "facility", clientProbe: probe });

  assert.equal(check(report, "doorNotInRevealSet").pass, false);
});

test("fails client and authority door-state disagreement", () => {
  const probe = clientFixture();
  probe.building.doorOpen = true;
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    authorityExport: authorityFixture(),
    clientProbe: probe,
  });

  assert.equal(check(report, "doorAuthorityParity").pass, false);
});

test("requires nonnegative bounded shadow clearance", () => {
  const probe = clientFixture();
  probe.pawn.shadowPlaneY = 0.019;
  const report = diagnose({ slice: sliceFixture(), propId: "facility", clientProbe: probe });

  assert.equal(check(report, "shadowClearance").pass, false);
});

test("rejects malformed Three.js world bounds", () => {
  const probe = clientFixture();
  delete probe.building.worldBounds.door.max.z;
  const report = diagnose({ slice: sliceFixture(), propId: "facility", clientProbe: probe });

  assert.equal(check(report, "doorWorldBounds").pass, false);
});

test("classifies direct, clamped, slide, no-progress, and rejected movement", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    movementTrace: {
      records: [
        { accepted: true, attemptedDelta: { x: 4, y: 0 }, resolvedDelta: { x: 4, y: 0 } },
        { accepted: true, attemptedDelta: { x: 4, y: 0 }, resolvedDelta: { x: 2, y: 0 } },
        { accepted: true, attemptedDelta: { x: 4, y: 4 }, resolvedDelta: { x: 0, y: 3 } },
        { accepted: true, attemptedDelta: { x: 4, y: 0 }, resolvedDelta: { x: 0, y: 0 } },
        { accepted: false, attemptedDelta: { x: 1, y: 0 } },
      ],
    },
  });

  assert.equal(report.layers.movement.status, "pass");
  assert.deepEqual(report.layers.movement.classifications, {
    direct: 1,
    clamped: 1,
    slid: 1,
    "no-progress": 1,
    rejected: 1,
    malformed: 0,
  });
});

test("fails a malformed provided movement trace", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    movementTrace: { records: [{ accepted: true, attemptedDelta: { x: 1, y: 0 } }] },
  });

  assert.equal(report.layers.movement.status, "fail");
  assert.equal(report.layers.movement.classifications.malformed, 1);
  assert.equal(report.overall.status, "fail");
});

test("fails a provided client layer missing building or pawn", () => {
  const report = diagnose({
    slice: sliceFixture(),
    propId: "facility",
    clientProbe: { building: clientFixture().building },
  });

  assert.equal(report.layers.client.status, "fail");
});

test("fails inconsistent cutaway phase, target, and fade", () => {
  const probe = clientFixture();
  probe.building.phase = "interior";
  probe.building.target = 0;
  probe.building.fade = 0;
  const report = diagnose({ slice: sliceFixture(), propId: "facility", clientProbe: probe });

  assert.equal(check(report, "phase").pass, false);
});
