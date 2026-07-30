import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  assertHeadedLoopbackUrl,
  charSelectEnterReady,
  charSelectRowIsInteractable,
  charSelectRowIsSelected,
  launchBrowser,
  managedSessionName,
  managedSessionPresent,
  parseManagedSession,
  renewManagedSession,
  startManagedSessionRenewal,
  stopManagedSession,
} from "./browser.mjs";

describe("client3d managed browser lifecycle helpers", () => {
  it("builds 1-32 char lowercase alphanumeric-hyphen names from run ids", () => {
    const name = managedSessionName("client3d-gate-20260726T052901Z-913988-151");
    assert.match(name, /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u);
    assert.ok(name.length >= 1 && name.length <= 32);
    assert.equal(
      managedSessionName("Client3D_Gate!!ONE"),
      "client3d-gate-one",
    );
    assert.notEqual(
      managedSessionName("client3d-gate-run-aaaa"),
      managedSessionName("client3d-gate-run-bbbb"),
    );
  });

  it("hashes long runIds so values differing only after char 32 stay distinct", () => {
    const prefix = "client3d-farm-shard-prefix-aaaaa"; // exactly 32 cleaned chars
    assert.equal(prefix.length, 32);
    const a = `${prefix}TAIL-ONE-EXTRA`;
    const b = `${prefix}TAIL-TWO-EXTRA`;
    assert.ok(a.length > 32 && b.length > 32);
    assert.equal(a.slice(0, 32), b.slice(0, 32));
    const nameA = managedSessionName(a);
    const nameB = managedSessionName(b);
    assert.match(nameA, /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u);
    assert.match(nameB, /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u);
    assert.ok(nameA.length <= 32 && nameB.length <= 32);
    assert.notEqual(nameA, nameB);
    assert.equal(managedSessionName(a), nameA);
  });

  it("accepts only loopback vite URLs for headed launch", () => {
    assert.equal(assertHeadedLoopbackUrl("http://127.0.0.1:29700"), "http://127.0.0.1:29700");
    assert.equal(assertHeadedLoopbackUrl("https://127.0.0.1:29700/"), "https://127.0.0.1:29700/");
    assert.throws(() => assertHeadedLoopbackUrl("http://localhost:29700"), /loopback/u);
    assert.throws(() => assertHeadedLoopbackUrl("http://example.com"), /loopback/u);
    assert.throws(() => assertHeadedLoopbackUrl("file:///tmp/x"), /loopback/u);
  });

  it("parses only matching session JSON with a valid cdp_port", () => {
    const stdout = [
      "noise before",
      JSON.stringify({ name: "other", cdp_port: 9333 }),
      JSON.stringify({ name: "client3d-run", cdp_port: 9222 }),
      "trailing noise",
    ].join("\n");
    assert.deepEqual(parseManagedSession(stdout, "client3d-run"), {
      name: "client3d-run",
      cdp_port: 9222,
    });
    assert.throws(
      () => parseManagedSession(JSON.stringify({ name: "client3d-run", cdp_port: 80 }), "client3d-run"),
      /no matching session record/u,
    );
    assert.throws(
      () => parseManagedSession(JSON.stringify({ name: "other", cdp_port: 9222 }), "client3d-run"),
      /no matching session record/u,
    );
  });

  it("detects session presence from status JSON only", () => {
    assert.equal(
      managedSessionPresent({ status: 0, stdout: JSON.stringify({ sessions: [{ name: "client3d-run" }] }) }, "client3d-run"),
      true,
    );
    assert.equal(
      managedSessionPresent({ status: 0, stdout: JSON.stringify({ sessions: [{ name: "other" }] }) }, "client3d-run"),
      false,
    );
    assert.equal(managedSessionPresent({ status: 0, stdout: "" }, "client3d-run"), false);
    assert.equal(managedSessionPresent({ status: 1, stdout: "" }, "client3d-run"), true);
  });

  it("stop retries and fails loud on survivors", async () => {
    const calls = [];
    const command = (argv) => {
      calls.push(argv);
      return argv[0] === "stop"
        ? { status: 1 }
        : { status: 0, stdout: JSON.stringify({ sessions: [{ name: "client3d-run" }] }) };
    };
    await assert.rejects(stopManagedSession("client3d-run", command, async () => {}), /survivor/u);
    assert.equal(calls.filter(([verb]) => verb === "stop").length, 12);
  });

  it("stop succeeds once status no longer lists the owned name", async () => {
    let statusCalls = 0;
    const command = (argv) => {
      if (argv[0] === "stop") return { status: 0, stdout: "" };
      statusCalls += 1;
      if (statusCalls < 3) {
        return { status: 0, stdout: JSON.stringify({ sessions: [{ name: "client3d-run" }] }) };
      }
      return { status: 0, stdout: JSON.stringify({ sessions: [] }) };
    };
    await assert.doesNotReject(stopManagedSession("client3d-run", command, async () => {}));
    assert.equal(statusCalls, 3);
  });

  it("renew issues owned renew --name --ttl and fails loud", () => {
    const calls = [];
    const ok = renewManagedSession("client3d-run", (argv) => {
      calls.push(argv);
      return { status: 0, stdout: "{}" };
    });
    assert.equal(ok.status, 0);
    assert.deepEqual(calls, [["renew", "--name", "client3d-run", "--ttl", "3600"]]);
    assert.throws(
      () => renewManagedSession("client3d-run", () => ({ status: 1, stderr: "nope" })),
      /renew failed/u,
    );
  });

  it("renewal timer stores failures for a visible close verdict and clears", () => {
    let handler = null;
    let cleared = false;
    const renewal = startManagedSessionRenewal("client3d-run", {
      command: () => ({ status: 1, stderr: "lease-denied" }),
      everyMs: 1000,
      setIntervalFn: (fn) => {
        handler = fn;
        return 1;
      },
      clearIntervalFn: () => {
        cleared = true;
      },
    });
    assert.equal(typeof handler, "function");
    handler();
    const err = renewal.takeError();
    assert.match(String(err?.message ?? err), /renew failed/u);
    renewal.clear();
    assert.equal(cleared, true);
  });

  it("retries once on nonzero start and succeeds if second start returns status 0", async () => {
    const startCalls = [];
    const stopCalls = [];
    const delays = [];
    const chromium = {
      launch: async () => { throw new Error("headless path must not run"); },
      connectOverCDP: async (url) => {
        assert.equal(url, "http://127.0.0.1:9222");
        return {
          close: async () => {},
        };
      },
    };

    let attempt = 0;
    const command = (argv) => {
      if (argv[0] === "start") {
        startCalls.push(argv);
        attempt += 1;
        if (attempt === 1) {
          return { status: 1, stderr: "busy", stdout: "" };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ name: argv[1], cdp_port: 9222 }),
        };
      }
      if (argv[0] === "stop") {
        stopCalls.push(argv);
        return { status: 0, stdout: "" };
      }
      if (argv[0] === "status") {
        return { status: 0, stdout: JSON.stringify({ sessions: [] }) };
      }
      return { status: 0 };
    };

    const browser = await launchBrowser(chromium, {
      headed: true,
      runId: "client3d-run",
      url: "http://127.0.0.1:29700",
      managedBrowserCommand: command,
      managedBrowserStartDelay: async (ms) => { delays.push(ms); },
    });

    assert.equal(startCalls.length, 2);
    const firstName = startCalls[0][1];
    const secondName = startCalls[1][1];
    assert.notEqual(firstName, secondName);
    assert.match(firstName, /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u);
    assert.match(secondName, /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u);
    assert.deepEqual(delays, [1000]);
    assert.equal(browser.__managedSessionName, secondName);

    await browser.close();
    assert.equal(stopCalls.length, 1);
    assert.equal(stopCalls[0][1], secondName);
  });
  it("throws diagnostic without stopping any session when both start attempts fail with nonzero status", async () => {
    const startCalls = [];
    const stopCalls = [];
    const delays = [];
    const chromium = {
      launch: async () => { throw new Error("headless path must not run"); },
      connectOverCDP: async () => { throw new Error("CDP must not connect after failed start"); },
    };

    const command = (argv) => {
      if (argv[0] === "start") {
        startCalls.push(argv);
        return { status: 1, stderr: "resource busy", stdout: "active:inactive" };
      }
      if (argv[0] === "stop") {
        stopCalls.push(argv);
        return { status: 0, stdout: "" };
      }
      return { status: 0 };
    };

    await assert.rejects(
      launchBrowser(chromium, {
        headed: true,
        runId: "client3d-run",
        url: "http://127.0.0.1:29700",
        managedBrowserCommand: command,
        managedBrowserStartDelay: async (ms) => { delays.push(ms); },
      }),
      /failed to start/u,
    );

    assert.equal(startCalls.length, 2);
    const firstName = startCalls[0][1];
    const secondName = startCalls[1][1];
    assert.notEqual(firstName, secondName);
    assert.match(firstName, /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u);
    assert.match(secondName, /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u);
    assert.deepEqual(delays, [1000]);
    assert.equal(stopCalls.length, 0);
  });
  it("uses only one attempt when the first start succeeds", async () => {
    const startCalls = [];
    const stopCalls = [];
    const delays = [];
    const chromium = {
      launch: async () => { throw new Error("headless path must not run"); },
      connectOverCDP: async (url) => {
        assert.equal(url, "http://127.0.0.1:9222");
        return { close: async () => {} };
      },
    };

    const command = (argv) => {
      if (argv[0] === "start") {
        startCalls.push(argv);
        return { status: 0, stdout: JSON.stringify({ name: argv[1], cdp_port: 9222 }) };
      }
      if (argv[0] === "stop") {
        stopCalls.push(argv);
        return { status: 0 };
      }
      if (argv[0] === "status") {
        return { status: 0, stdout: JSON.stringify({ sessions: [] }) };
      }
      return { status: 0 };
    };

    const browser = await launchBrowser(chromium, {
      headed: true,
      runId: "client3d-run",
      url: "http://127.0.0.1:29700",
      managedBrowserCommand: command,
      managedBrowserStartDelay: async (ms) => { delays.push(ms); },
    });

    assert.equal(startCalls.length, 1);
    assert.equal(delays.length, 0);
    assert.equal(browser.__managedSessionName, "client3d-run");

    await browser.close();
    assert.equal(stopCalls.length, 1);
    assert.equal(stopCalls[0][1], "client3d-run");
  });
  it("does not retry if start succeeds but parse or CDP connection fails, stopping the owned session", async () => {
    const startCalls = [];
    const stopCalls = [];
    const chromium = {
      launch: async () => { throw new Error("headless path must not run"); },
      connectOverCDP: async () => { throw new Error("CDP attach failed"); },
    };

    const command = (argv) => {
      if (argv[0] === "start") {
        startCalls.push(argv);
        return { status: 0, stdout: JSON.stringify({ name: argv[1], cdp_port: 9222 }) };
      }
      if (argv[0] === "stop") {
        stopCalls.push(argv);
        return { status: 0 };
      }
      if (argv[0] === "status") {
        return { status: 0, stdout: JSON.stringify({ sessions: [] }) };
      }
      return { status: 0 };
    };

    await assert.rejects(
      launchBrowser(chromium, {
        headed: true,
        runId: "client3d-run",
        url: "http://127.0.0.1:29700",
        managedBrowserCommand: command,
      }),
      /CDP attach failed/u,
    );

    assert.equal(startCalls.length, 1);
    assert.equal(stopCalls.length, 1);
    assert.equal(stopCalls[0][1], "client3d-run");
  });

});

describe("client3d charselect enterWorld row predicates", () => {
  it("treats attached visible rows as interactable even when link-dead", () => {
    assert.equal(charSelectRowIsInteractable({
      connected: true,
      active: false,
      display: "flex",
      visibility: "visible",
      opacity: "1",
      linkdead: true,
    }), true);
    assert.equal(charSelectRowIsInteractable({
      connected: true,
      active: false,
      display: "flex",
      visibility: "visible",
      opacity: "1",
      linkdead: false,
    }), true);
  });

  it("rejects detached or hidden rows regardless of linkdead", () => {
    assert.equal(charSelectRowIsInteractable({
      connected: false,
      active: false,
      display: "none",
      visibility: "hidden",
      opacity: "0",
      linkdead: false,
    }), false);
    assert.equal(charSelectRowIsInteractable({
      connected: true,
      active: true,
      display: "none",
      visibility: "visible",
      opacity: "1",
      linkdead: true,
    }), false);
    assert.equal(charSelectRowIsInteractable({
      connected: true,
      active: true,
      display: "flex",
      visibility: "hidden",
      opacity: "1",
      linkdead: false,
    }), false);
    assert.equal(charSelectRowIsInteractable({
      connected: true,
      active: true,
      display: "flex",
      visibility: "visible",
      opacity: "0",
      linkdead: false,
    }), false);
  });

  it("latches selection only when the exact row is connected and data-active", () => {
    assert.equal(charSelectRowIsSelected({
      connected: true,
      active: true,
      display: "flex",
      visibility: "visible",
      opacity: "1",
      linkdead: true,
    }), true);
    assert.equal(charSelectRowIsSelected({
      connected: true,
      active: false,
      display: "flex",
      visibility: "visible",
      opacity: "1",
      linkdead: false,
    }), false);
    assert.equal(charSelectRowIsSelected({
      connected: false,
      active: true,
      display: "flex",
      visibility: "visible",
      opacity: "1",
      linkdead: false,
    }), false);
  });

  it("requires exact active row, enabled enter button, and focus before activation", () => {
    assert.equal(charSelectEnterReady({
      rowConnected: true,
      rowActive: true,
      enterConnected: true,
      enterEnabled: true,
      focused: true,
    }), true);
    assert.equal(charSelectEnterReady({
      rowConnected: true,
      rowActive: true,
      enterConnected: true,
      enterEnabled: true,
      focused: false,
    }), false);
    assert.equal(charSelectEnterReady({
      rowConnected: true,
      rowActive: false,
      enterConnected: true,
      enterEnabled: true,
      focused: true,
    }), false);
    assert.equal(charSelectEnterReady({
      rowConnected: true,
      rowActive: true,
      enterConnected: true,
      enterEnabled: false,
      focused: true,
    }), false);
    assert.equal(charSelectEnterReady({
      rowConnected: false,
      rowActive: true,
      enterConnected: true,
      enterEnabled: true,
      focused: true,
    }), false);
  });
});

