import { briefTest, claim, testBrief } from "@openwork/testkit";
import {
  EngineInstanceReaper,
  type TrackedEngineInstance,
} from "../../apps/server/src/engine-instance-reaper";

/**
 * The continuous engine keeps one managed OpenCode process alive across
 * workspace switches, so every visited workspace retains a live per-directory
 * instance — config, plugins, watchers, session caches — for the lifetime of
 * the app. The engine instance reaper is the reclamation policy: evict an
 * instance only when nothing holds it. This spec proves that policy and its
 * negative halves; apps/server/src/engine-instance-eviction.e2e.test.ts drives
 * the same loop through a running OpenWork server and mock engine.
 */

const ENGINE_URL = "http://127.0.0.1:4101";
const TTL_ENV = "OPENWORK_ENGINE_INSTANCE_IDLE_TTL_MS";

type Harness = {
  reaper: EngineInstanceReaper;
  disposed: TrackedEngineInstance[];
  clock: { now: number };
  setBusy: (directory: string, busy: boolean) => void;
  failProbes: (fail: boolean) => void;
  setActiveDirectory: (directory: string | null) => void;
  setEngineBaseUrl: (url: string | null) => void;
};

function createHarness(): Harness {
  const clock = { now: 1_000_000 };
  const busyByDirectory = new Map<string, boolean>();
  const disposed: TrackedEngineInstance[] = [];
  let probesFail = false;
  let activeDirectory: string | null = null;
  let engineBaseUrl: string | null = ENGINE_URL;
  const reaper = new EngineInstanceReaper({
    engineBaseUrl: () => engineBaseUrl,
    activeDirectory: () => activeDirectory,
    directoryBusy: async (entry) => {
      if (probesFail) throw new Error("status probe unavailable");
      return busyByDirectory.get(entry.directory) === true;
    },
    dispose: async (entry) => {
      disposed.push({ ...entry });
    },
    now: () => clock.now,
  });
  return {
    reaper,
    disposed,
    clock,
    setBusy: (directory, busy) => void busyByDirectory.set(directory, busy),
    failProbes: (fail) => void (probesFail = fail),
    setActiveDirectory: (directory) => void (activeDirectory = directory),
    setEngineBaseUrl: (url) => void (engineBaseUrl = url),
  };
}

function use(directory: string) {
  return { directory, workspaceId: `ws-${directory}`, engineBaseUrl: ENGINE_URL };
}

async function withTtl<T>(ttlMs: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env[TTL_ENV];
  process.env[TTL_ENV] = String(ttlMs);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[TTL_ENV];
    else process.env[TTL_ENV] = previous;
  }
}

briefTest(testBrief({
  behavior: "Idle per-directory engine instances are reclaimed without touching anything a user still depends on.",
  claims: {
    idleEviction: claim("an idle, inactive, unwatched instance is evicted once the idle TTL elapses", {
      never: "dispose an instance before its TTL has fully elapsed",
    }),
    activeImmunity: claim("the active workspace's instance survives any amount of idle time", {
      never: "dispose the instance of the workspace the user is in",
    }),
    liveRunHold: claim("an instance reporting a non-idle session stays and its idle clock restarts", {
      never: "dispose an instance with a live background run",
    }),
    watchedHold: claim("an instance held by an open engine event stream stays until the hold is released", {
      never: "dispose an instance while any tab still watches its workspace",
    }),
    reattachOnce: claim("after an eviction, the next traffic for that workspace reports the re-attach mark exactly once", {
      never: "report the mark twice or drop it before the workspace returns",
    }),
    safeDefaults: claim("unknown activity, retired engine generations, unmanaged engines, and a zero TTL never dispose", {
      never: "evict when the engine's state cannot be read or is not ours to manage",
    }),
  },
}), async ({ prove }) => {
  await withTtl(1_000, async () => {
    // idleEviction — both halves of the TTL boundary.
    const idle = createHarness();
    idle.reaper.noteUsed(use("/work/background"));
    idle.clock.now += 999;
    const beforeTtl = await idle.reaper.sweep();
    const disposedBeforeTtl = idle.disposed.length;
    idle.clock.now += 2;
    const afterTtl = await idle.reaper.sweep();
    prove.idleEviction(
      beforeTtl === 0 && disposedBeforeTtl === 0 && afterTtl === 1 && idle.disposed[0]?.directory === "/work/background",
      `At TTL-1ms the sweep evicted ${beforeTtl} instances and disposed ${disposedBeforeTtl}; at TTL+1ms it evicted ${afterTtl} and disposed /work/background.`,
    );

    // activeImmunity — the active workspace outlives any idle window.
    const active = createHarness();
    active.setActiveDirectory("/work/active");
    active.reaper.noteUsed(use("/work/active"));
    active.clock.now += 100_000;
    const activeSweep = await active.reaper.sweep();
    prove.activeImmunity(
      activeSweep === 0 && active.disposed.length === 0 && active.reaper.snapshot()[0]?.directory === "/work/active",
      `After 100x the TTL the active instance was still tracked and ${active.disposed.length} disposes ran.`,
    );

    // liveRunHold — busy sessions hold, and going idle restarts the clock.
    const running = createHarness();
    running.reaper.noteUsed(use("/work/running"));
    running.setBusy("/work/running", true);
    running.clock.now += 100_000;
    const busySweep = await running.reaper.sweep();
    running.setBusy("/work/running", false);
    running.clock.now += 999;
    const freshIdleSweep = await running.reaper.sweep();
    running.clock.now += 2;
    const staleIdleSweep = await running.reaper.sweep();
    prove.liveRunHold(
      busySweep === 0 && freshIdleSweep === 0 && staleIdleSweep === 1,
      `Busy at 100x TTL: ${busySweep} evictions. Idle again: ${freshIdleSweep} before the restarted TTL, ${staleIdleSweep} after it.`,
    );

    // watchedHold — a stream hold pins the instance; release restarts the clock.
    const watched = createHarness();
    const release = watched.reaper.holdStream(use("/work/watched"));
    watched.clock.now += 100_000;
    const heldSweep = await watched.reaper.sweep();
    release();
    watched.clock.now += 999;
    const justReleasedSweep = await watched.reaper.sweep();
    watched.clock.now += 2;
    const releasedStaleSweep = await watched.reaper.sweep();
    prove.watchedHold(
      heldSweep === 0 && justReleasedSweep === 0 && releasedStaleSweep === 1,
      `Held at 100x TTL: ${heldSweep} evictions; after release: ${justReleasedSweep} inside the restarted TTL, ${releasedStaleSweep} past it.`,
    );

    // reattachOnce — the mark survives a stream hold and reports exactly once.
    const returning = createHarness();
    returning.reaper.noteUsed(use("/work/background"));
    returning.clock.now += 1_001;
    await returning.reaper.sweep();
    const holdAfterEviction = returning.reaper.holdStream(use("/work/background"));
    const firstUse = returning.reaper.noteUsed(use("/work/background"));
    const secondUse = returning.reaper.noteUsed(use("/work/background"));
    holdAfterEviction();
    prove.reattachOnce(
      firstUse === true && secondUse === false,
      `After eviction and an intervening stream hold, noteUsed reported the mark once (${firstUse}) and then never again (${secondUse}).`,
    );

    // safeDefaults — unknown, retired, and unmanaged states never dispose.
    const unknown = createHarness();
    unknown.reaper.noteUsed(use("/work/unknown"));
    unknown.failProbes(true);
    unknown.clock.now += 100_000;
    const unknownSweep = await unknown.reaper.sweep();

    const retired = createHarness();
    retired.reaper.noteUsed(use("/work/old"));
    retired.setEngineBaseUrl("http://127.0.0.1:4999");
    retired.clock.now += 100_000;
    const retiredSweep = await retired.reaper.sweep();
    const retiredDropped = retired.reaper.snapshot().length === 0;

    const unmanaged = createHarness();
    unmanaged.reaper.noteUsed(use("/work/attached"));
    unmanaged.setEngineBaseUrl(null);
    unmanaged.clock.now += 100_000;
    const unmanagedSweep = await unmanaged.reaper.sweep();

    const disabled = createHarness();
    disabled.reaper.noteUsed(use("/work/disabled"));
    disabled.clock.now += 100_000_000;
    const disabledSweep = await withTtl(0, () => disabled.reaper.sweep());

    prove.safeDefaults(
      unknownSweep === 0 && unknown.disposed.length === 0
        && retiredSweep === 0 && retired.disposed.length === 0 && retiredDropped
        && unmanagedSweep === 0 && unmanaged.disposed.length === 0
        && disabledSweep === 0 && disabled.disposed.length === 0,
      `Unreadable probe: ${unknownSweep} evictions. Retired generation: ${retiredSweep} evictions with the stale entry dropped (${retiredDropped}). No managed engine: ${unmanagedSweep}. TTL 0: ${disabledSweep}. No disposes ran in any of them.`,
    );
  });
});
