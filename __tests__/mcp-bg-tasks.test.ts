import { afterEach, describe, expect, test, vi } from "vitest";
import {
  callWithAutoBackground,
  clearMcpBgTasksForTests,
  DEFAULT_MCP_AUTO_BACKGROUND_MS,
  detachNote,
  getMcpBgTask,
  isAutoBackgroundExempt,
  listMcpBgTasks,
  type McpBgTask,
  renderMcpCompletionMessage,
  resolveAutoBackgroundMs,
} from "../mcp-bg-tasks.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => clearMcpBgTasksForTests());

describe("threshold + exemption config", () => {
  test("default is 120s", () => {
    expect(resolveAutoBackgroundMs({})).toBe(DEFAULT_MCP_AUTO_BACKGROUND_MS);
    expect(DEFAULT_MCP_AUTO_BACKGROUND_MS).toBe(120_000);
  });
  test("env override honored", () => {
    expect(resolveAutoBackgroundMs({ CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "5000" })).toBe(5000);
  });
  test("invalid env falls back to default", () => {
    expect(resolveAutoBackgroundMs({ CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "nope" })).toBe(
      DEFAULT_MCP_AUTO_BACKGROUND_MS,
    );
  });
  test("0 disables", () => {
    expect(resolveAutoBackgroundMs({ CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" })).toBe(0);
  });
  test("IDE MCP servers are exempt (case-insensitive)", () => {
    expect(isAutoBackgroundExempt("sse-ide")).toBe(true);
    expect(isAutoBackgroundExempt("ws-ide")).toBe(true);
    expect(isAutoBackgroundExempt("WS-IDE")).toBe(true);
    expect(isAutoBackgroundExempt("github")).toBe(false);
  });
});

describe("callWithAutoBackground — foreground (settles within threshold)", () => {
  test("a fast call resolves in the foreground and never backgrounds", async () => {
    const cleanup = vi.fn();
    const notify = vi.fn();
    const outcome = await callWithAutoBackground({
      serverName: "github",
      toolName: "search",
      thresholdMs: 1000,
      call: async () => ({ content: [{ type: "text", text: "hi" }] }),
      renderResult: () => "hi",
      cleanup,
      notifyCompletion: notify,
    });
    expect(outcome.kind).toBe("resolved");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(listMcpBgTasks()).toHaveLength(0);
  });

  test("a fast rejection surfaces in the foreground and cleans up once", async () => {
    const cleanup = vi.fn();
    const outcome = await callWithAutoBackground({
      serverName: "github",
      toolName: "search",
      thresholdMs: 1000,
      call: async () => {
        throw new Error("boom");
      },
      renderResult: () => "",
      cleanup,
    });
    expect(outcome.kind).toBe("rejected");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(listMcpBgTasks()).toHaveLength(0);
  });
});

describe("callWithAutoBackground — background (exceeds threshold)", () => {
  test("a slow call is detached past the threshold; the fast one is not (same setup)", async () => {
    // Fail-on-baseline framing: this pair only both pass when the race actually
    // fires. If the threshold were ignored (always await), the slow call would
    // return `resolved`, not `backgrounded`.
    const slow = await callWithAutoBackground({
      serverName: "github",
      toolName: "slow",
      thresholdMs: 20,
      call: () => new Promise((res) => setTimeout(() => res({ content: [{ type: "text", text: "done" }] }), 200)),
      renderResult: renderText,
      cleanup: () => {},
    });
    const fast = await callWithAutoBackground({
      serverName: "github",
      toolName: "fast",
      thresholdMs: 20,
      call: () => new Promise((res) => setTimeout(() => res({ content: [{ type: "text", text: "quick" }] }), 1)),
      renderResult: renderText,
      cleanup: () => {},
    });
    expect(slow.kind).toBe("backgrounded");
    expect(fast.kind).toBe("resolved");
  });

  test("detach registers a running task, defers cleanup, then completes once and notifies", async () => {
    const cleanup = vi.fn();
    const notify = vi.fn();
    let resolveCall!: (v: unknown) => void;
    const outcome = await callWithAutoBackground({
      serverName: "github",
      toolName: "slow",
      thresholdMs: 15,
      call: () => new Promise((res) => (resolveCall = res)),
      renderResult: renderText,
      cleanup,
      notifyCompletion: notify,
    });

    expect(outcome.kind).toBe("backgrounded");
    if (outcome.kind !== "backgrounded") return;
    // Cleanup is deferred while the call is still in flight in the background.
    expect(cleanup).not.toHaveBeenCalled();
    const task = getMcpBgTask(outcome.taskId);
    expect(task?.status).toBe("running");
    expect(outcome.note).toContain(outcome.taskId);
    expect(outcome.note).toContain("does NOT survive");

    // Now let the underlying promise settle — the sole attached handler fires.
    resolveCall({ content: [{ type: "text", text: "eventual" }] });
    await flush();

    expect(cleanup).toHaveBeenCalledTimes(1); // exactly once, no double-resolve
    expect(notify).toHaveBeenCalledTimes(1);
    expect(getMcpBgTask(outcome.taskId)?.status).toBe("completed");
    expect(getMcpBgTask(outcome.taskId)?.resultText).toBe("eventual");
  });

  test("a user TaskStop (abort) marks the task killed and stays silent", async () => {
    const cleanup = vi.fn();
    const notify = vi.fn();
    let rejectCall!: (e: unknown) => void;
    const outcome = await callWithAutoBackground({
      serverName: "github",
      toolName: "slow",
      thresholdMs: 15,
      call: (signal) =>
        new Promise((_res, rej) => {
          rejectCall = rej;
          signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
      renderResult: renderText,
      cleanup,
      notifyCompletion: notify,
    });
    expect(outcome.kind).toBe("backgrounded");
    if (outcome.kind !== "backgrounded") return;

    // Simulate TaskStop → adapter.kill → task.abort()
    getMcpBgTask(outcome.taskId)!.abort();
    await flush();

    expect(getMcpBgTask(outcome.taskId)?.status).toBe("killed");
    expect(cleanup).toHaveBeenCalledTimes(1);
    // Deliberate stop → no completion wake.
    expect(notify).not.toHaveBeenCalled();
    void rejectCall;
  });

  test("a background call that rejects still cleans up once and notifies (failed)", async () => {
    const cleanup = vi.fn();
    const notify = vi.fn();
    let rejectCall!: (e: unknown) => void;
    const outcome = await callWithAutoBackground({
      serverName: "github",
      toolName: "slow",
      thresholdMs: 15,
      call: () => new Promise((_res, rej) => (rejectCall = rej)),
      renderResult: renderText,
      cleanup,
      notifyCompletion: notify,
    });
    expect(outcome.kind).toBe("backgrounded");
    if (outcome.kind !== "backgrounded") return;

    rejectCall(new Error("late failure"));
    await flush();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const task = getMcpBgTask(outcome.taskId);
    expect(task?.status).toBe("failed");
    expect(task?.error).toContain("late failure");
  });
});

describe("callWithAutoBackground — disabled / exempt", () => {
  test("threshold<=0 awaits in the foreground even for a slow call", async () => {
    const outcome = await callWithAutoBackground({
      serverName: "sse-ide",
      toolName: "diagnostics",
      thresholdMs: 0,
      call: () => new Promise((res) => setTimeout(() => res({ content: [{ type: "text", text: "ok" }] }), 40)),
      renderResult: renderText,
      cleanup: () => {},
    });
    expect(outcome.kind).toBe("resolved");
    expect(listMcpBgTasks()).toHaveLength(0);
  });
});

describe("notification rendering", () => {
  test("completion message carries a task_notification envelope", () => {
    const task: McpBgTask = {
      id: "mcp_x",
      serverName: "github",
      toolName: "search",
      description: "github/search",
      startedAt: 1000,
      endedAt: 4000,
      status: "completed",
      abort: () => {},
    };
    const msg = renderMcpCompletionMessage(task);
    expect(msg).toContain("<task_notification>");
    expect(msg).toContain("<task_id>mcp_x</task_id>");
    expect(msg).toContain("background_mcp");
    expect(msg).toContain("<elapsed_s>3.0</elapsed_s>");
  });

  test("detachNote names the threshold in seconds and TaskStop", () => {
    const note = detachNote("mcp_y", "github", "search", 120_000);
    expect(note).toContain("120s");
    expect(note).toContain('TaskStop(task_id="mcp_y")');
  });
});

function renderText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })?.content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || "(empty result)";
}
