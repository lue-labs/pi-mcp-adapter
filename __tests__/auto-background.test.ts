import { describe, expect, it, vi } from "vitest";
import {
  buildBackgroundNote,
  DEFAULT_AUTO_BACKGROUND_MS,
  McpBackgroundTaskStore,
  raceAutoBackground,
  resolveAutoBackgroundMs,
} from "../auto-background.ts";

function deferred<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("resolveAutoBackgroundMs", () => {
  it("exempts IDE transports (never background)", () => {
    expect(resolveAutoBackgroundMs({ transport: "sse-ide" })).toBe(0);
    expect(resolveAutoBackgroundMs({ transport: "ws-ide" })).toBe(0);
  });

  it("defaults to 120s and honors the env override", () => {
    expect(resolveAutoBackgroundMs({ transport: "stdio" })).toBe(DEFAULT_AUTO_BACKGROUND_MS);
    expect(resolveAutoBackgroundMs({})).toBe(DEFAULT_AUTO_BACKGROUND_MS);
    expect(resolveAutoBackgroundMs({ envValue: "5000" })).toBe(5000);
    expect(resolveAutoBackgroundMs({ envValue: "0" })).toBe(0);
    expect(resolveAutoBackgroundMs({ envValue: "junk" })).toBe(DEFAULT_AUTO_BACKGROUND_MS);
  });
});

describe("raceAutoBackground", () => {
  it("backgrounds a slow tool: returns a note + registers a stoppable task, TaskStop kills it", async () => {
    const store = new McpBackgroundTaskStore();
    const registerTaskAdapter = vi.fn();
    expect(store.ensureRegistered({ registerTaskAdapter })).toBe(true);

    let aborted = false;
    const slow = deferred(1000, "eventual");

    const outcome = await raceAutoBackground(slow, {
      ms: 20,
      onBackground: () => store.add('MCP tool "slow" (demo)', () => {
        aborted = true;
      }),
      settle: (id, status, error) => store.settle(id, status, error),
    });

    expect(outcome.backgrounded).toBe(true);
    expect(outcome.taskId).toBeTruthy();

    const note = buildBackgroundNote("slow", outcome.taskId!, 20);
    expect(note).toContain("moved to background as task");
    expect(note).toContain("use TaskStop(task_id)");
    expect(note).toContain("does not survive exiting this session");

    // The single mcp_background adapter is registered exactly once.
    expect(registerTaskAdapter).toHaveBeenCalledTimes(1);
    const adapter = registerTaskAdapter.mock.calls[0][0] as {
      type: string;
      snapshot: (id: string) => unknown;
      list: () => Array<{ id: string; status: string }>;
      kill: (id: string) => Promise<{ ok: boolean }>;
    };
    expect(adapter.type).toBe("mcp_background");
    expect(adapter.list().map((t) => t.id)).toContain(outcome.taskId);

    // TaskStop → adapter.kill aborts the underlying call and marks it killed.
    const result = await adapter.kill(outcome.taskId!);
    expect(result.ok).toBe(true);
    expect(aborted).toBe(true);
    expect(store.snapshot(outcome.taskId!)?.status).toBe("killed");
  });

  it("leaves a fast tool untouched: no background, no task created", async () => {
    const onBackground = vi.fn(() => "should-not-run");
    const outcome = await raceAutoBackground(Promise.resolve("quick"), {
      ms: 50,
      onBackground,
      settle: () => {},
    });
    expect(outcome.backgrounded).toBe(false);
    expect(outcome.result).toBe("quick");
    expect(onBackground).not.toHaveBeenCalled();
  });

  it("never backgrounds when the threshold is 0 (IDE-exempt path)", async () => {
    const onBackground = vi.fn(() => "nope");
    const outcome = await raceAutoBackground(deferred(30, "late"), {
      ms: 0,
      onBackground,
      settle: () => {},
    });
    expect(outcome.backgrounded).toBe(false);
    expect(outcome.result).toBe("late");
    expect(onBackground).not.toHaveBeenCalled();
  });

  it("a backgrounded call that finishes on its own settles the task as completed (no double-resolve)", async () => {
    const store = new McpBackgroundTaskStore();
    store.ensureRegistered({ registerTaskAdapter: vi.fn() });
    const slow = deferred(20, "finished");
    const outcome = await raceAutoBackground(slow, {
      ms: 5,
      onBackground: () => store.add("MCP tool x", () => {}),
      settle: (id, status, error) => store.settle(id, status, error),
    });
    expect(outcome.backgrounded).toBe(true);
    await slow; // let the detached settle run
    await Promise.resolve();
    expect(store.snapshot(outcome.taskId!)?.status).toBe("completed");
  });
});

describe("graceful degradation (upstream / older Pi)", () => {
  it("disables auto-background when the host lacks registerTaskAdapter", () => {
    const store = new McpBackgroundTaskStore();
    expect(store.ensureRegistered({})).toBe(false);
  });
});
