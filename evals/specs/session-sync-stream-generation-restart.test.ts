import { expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import {
  startSyncStreamLifecycle,
  type SyncStreamPhase,
} from "../../apps/app/src/react-app/domains/session/sync/sync-stream-lifecycle";

/**
 * The workspace event stream must never park in a terminal dead state while
 * a task keeps running on the server. Auth-shaped subscribe failures (401,
 * 403, 404) can be transient — a restarting local server or a rotating
 * runtime generation — so they retry on a slower bounded backoff, and a
 * token/runtime generation change restarts the stream immediately.
 */

function authError(status: number) {
  return Object.assign(new Error(`subscribe rejected with ${status}`), { status });
}

function isAuthError(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status: unknown }).status;
  return status === 401 || status === 403 || status === 404;
}

function streamOf(items: unknown[], options: { thenHang: boolean }, signal: AbortSignal): AsyncIterable<unknown> {
  return (async function* () {
    for (const item of items) yield item;
    if (options.thenHang) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  })();
}

test("a stream killed by a stale token restarts on generation change and resumes the same task's events", async () => {
  vi.useFakeTimers();
  try {
    let token = "generation-1";
    const received: string[] = [];
    const phases: SyncStreamPhase[] = [];
    const timeline: string[] = [];
    let subscribeAttempts = 0;

    const lifecycle = startSyncStreamLifecycle({
      subscribe: async (signal) => {
        subscribeAttempts += 1;
        timeline.push(`subscribe:${subscribeAttempts}:${token}`);
        if (subscribeAttempts === 1) {
          // The long task starts streaming, then the server drops the
          // connection (for example a local server restart).
          return streamOf(["task-started", "output-1"], { thenHang: false }, signal);
        }
        if (token !== "generation-2") throw authError(401);
        return streamOf(["output-2", "task-completed"], { thenHang: true }, signal);
      },
      onEvent: (event) => {
        received.push(String(event));
        timeline.push(`event:${String(event)}`);
      },
      onConnected: () => {
        timeline.push("reconcile");
      },
      onPhaseChange: (phase) => phases.push(phase),
      isAuthError,
    });

    // First connection delivers the first half of the task, then ends.
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual(["task-started", "output-1"]);
    expect(lifecycle.getPhase()).toBe("reconnecting");

    // Reconnects with the stale token are refused with 401 and park the
    // stream in the auth-blocked lane — visibly, not silently.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(subscribeAttempts).toBe(2);
    expect(lifecycle.getPhase()).toBe("auth-blocked");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(subscribeAttempts).toBe(3);
    expect(lifecycle.getPhase()).toBe("auth-blocked");

    // Negative half: while blocked, no events flow and nothing tight-loops.
    expect(received).toEqual(["task-started", "output-1"]);

    // The token rotates (reattachment) — the restart is immediate, with no
    // timer to wait out and no remount of the lifecycle.
    token = "generation-2";
    lifecycle.notifyGenerationChanged();
    expect(subscribeAttempts).toBe(4);
    await vi.advanceTimersByTimeAsync(0);

    // The same task's output resumes and completes on the same lifecycle.
    expect(received).toEqual(["task-started", "output-1", "output-2", "task-completed"]);
    expect(lifecycle.getPhase()).toBe("live");

    // Level reconciliation runs on the reconnect before any resumed events,
    // so cached idle state is corrected before the stream is trusted again.
    const reconnectSubscribe = timeline.indexOf("subscribe:4:generation-2");
    const reconnectReconcile = timeline.indexOf("reconcile", reconnectSubscribe);
    const resumedEvent = timeline.indexOf("event:output-2");
    expect(reconnectReconcile).toBeGreaterThan(reconnectSubscribe);
    expect(resumedEvent).toBeGreaterThan(reconnectReconcile);

    // The UI-facing phase history names every state it passed through.
    expect(phases).toEqual([
      "connecting",
      "live",
      "reconnecting",
      "connecting",
      "auth-blocked",
      "connecting",
      "auth-blocked",
      "connecting",
      "live",
    ]);

    lifecycle.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("a permanently invalid token backs off exponentially within bounds instead of tight-looping or dying", async () => {
  vi.useFakeTimers();
  try {
    const attemptAt: number[] = [];
    const lifecycle = startSyncStreamLifecycle({
      subscribe: async () => {
        attemptAt.push(Date.now());
        throw authError(403);
      },
      onEvent: () => {},
      isAuthError,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    // Never terminal: the stream keeps probing so a later server-side fix
    // (or generation change) can be picked up.
    expect(lifecycle.getPhase()).toBe("auth-blocked");
    expect(attemptAt.length).toBeGreaterThanOrEqual(5);

    // Negative proof: no infinite tight reconnect loop. Ten minutes of a
    // permanently invalid token yields a bounded number of attempts with a
    // growing, capped spacing.
    expect(attemptAt.length).toBeLessThanOrEqual(15);
    const gaps = attemptAt.slice(1).map((at, index) => at - attemptAt[index]);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(5_000);
      expect(gap).toBeLessThanOrEqual(60_000);
    }
    // The schedule is exponential until the cap, then holds the cap.
    expect(gaps.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(gaps.at(-1)).toBe(60_000);

    lifecycle.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("a silent live stream is exposed as stale and reconnected by the watchdog", async () => {
  vi.useFakeTimers();
  try {
    let attempts = 0;
    const phases: SyncStreamPhase[] = [];
    const lifecycle = startSyncStreamLifecycle({
      subscribe: async (signal) => {
        attempts += 1;
        return streamOf([], { thenHang: true }, signal);
      },
      onEvent: () => {},
      onPhaseChange: (phase) => phases.push(phase),
      isAuthError,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.getPhase()).toBe("live");

    // No events for longer than the stale threshold: the watchdog exposes
    // the stall as "stale" and replaces the connection.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(phases).toContain("stale");
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(lifecycle.getPhase()).toBe("live");

    lifecycle.dispose();
  } finally {
    vi.useRealTimers();
  }
});
