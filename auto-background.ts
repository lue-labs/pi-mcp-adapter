// Auto-background for long-running MCP tool calls (my-pi #1091).
//
// When a direct MCP tool call runs past a threshold (default 120s), it is
// "moved to the background": `execute` resolves once with a model-visible note
// and the original in-flight call keeps running, writing only to an in-process
// task store. The call becomes stoppable via the host's `TaskStop` tool and
// listable via `TaskBackgroundList`, by registering a single `mcp_background`
// `Task` adapter through the injected ExtensionAPI.
//
// Compatibility: `registerTaskAdapter`/`findTaskAdapter` are additions in
// Luke's pi-mono fork; they are absent on upstream/older Pi. This module
// feature-detects them — when absent, auto-background is disabled and behavior
// is unchanged (calls await to completion as before).
//
// Cache-safety: nothing here mutates `params.system` or `tools[]`. The note is
// a tool result only; `TaskStop`/`TaskBackgroundList` already exist as host
// tools.

export const DEFAULT_AUTO_BACKGROUND_MS = 120_000;

/**
 * Transports whose calls must never be auto-backgrounded: IDE-bridge MCP
 * connections are interactive/duplex and moving them to a detached task would
 * break the round-trip. Threshold resolves to 0 (exempt) for these.
 */
export const IDE_TRANSPORTS = new Set(["sse-ide", "ws-ide"]);

/** ExtensionAPI members added by the pi-mono fork (absent upstream). */
export interface TaskAdapterCapableApi {
  registerTaskAdapter?: (task: unknown) => void;
  findTaskAdapter?: (taskId: string) => unknown;
}

export type McpBackgroundStatus = "running" | "completed" | "failed" | "killed";

interface BackgroundTaskEntry {
  id: string;
  description: string;
  status: McpBackgroundStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
  abort: () => void;
}

/** Mirrors the host `TaskSnapshot` shape for the fields consumers read. */
export interface McpBackgroundSnapshot {
  id: string;
  type: "mcp_background";
  status: McpBackgroundStatus;
  description: string;
  startedAt: number;
  endedAt?: number;
  resumable: false;
  error?: string;
}

/**
 * Resolve the auto-background threshold in ms. IDE transports are exempt (0).
 * `PI_MCP_AUTO_BACKGROUND_MS` overrides the 120s default; a non-negative finite
 * number wins, anything else falls back to the default. `0` disables.
 */
export function resolveAutoBackgroundMs(input: {
  transport?: string;
  envValue?: string | undefined;
}): number {
  if (input.transport && IDE_TRANSPORTS.has(input.transport)) return 0;
  const raw = input.envValue;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_AUTO_BACKGROUND_MS;
}

/** Build the model-visible note returned when a call is backgrounded. */
export function buildBackgroundNote(toolName: string, taskId: string, ms: number): string {
  const seconds = Math.round(ms / 1000);
  return (
    `MCP tool "${toolName}" still running after ${seconds}s — moved to background as task ${taskId}; ` +
    `use TaskStop(task_id) to stop it; does not survive exiting this session.`
  );
}

/**
 * In-process store + single `mcp_background` Task adapter. One instance per
 * extension activation, shared across every direct tool executor.
 */
export class McpBackgroundTaskStore {
  private tasks = new Map<string, BackgroundTaskEntry>();
  private seq = 0;
  private registered = false;

  /**
   * Register the single `mcp_background` adapter with the host, once. Returns
   * true when the host supports task adapters (fork) — the signal that
   * auto-background may be used. False on upstream/older Pi (graceful degrade).
   */
  ensureRegistered(api: TaskAdapterCapableApi): boolean {
    if (this.registered) return true;
    if (typeof api.registerTaskAdapter !== "function") return false;
    api.registerTaskAdapter(this.adapter());
    this.registered = true;
    return true;
  }

  private toSnapshot(entry: BackgroundTaskEntry | undefined): McpBackgroundSnapshot | undefined {
    if (!entry) return undefined;
    return {
      id: entry.id,
      type: "mcp_background",
      status: entry.status,
      description: entry.description,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      resumable: false,
      error: entry.error,
    };
  }

  /** The host `Task` adapter. Typed loosely because upstream lacks the type. */
  private adapter() {
    return {
      type: "mcp_background" as const,
      snapshot: (taskId: string) => this.toSnapshot(this.tasks.get(taskId)),
      list: () =>
        [...this.tasks.values()]
          .map((entry) => this.toSnapshot(entry))
          .filter((snap): snap is McpBackgroundSnapshot => snap !== undefined),
      kill: async (taskId: string) => {
        const entry = this.tasks.get(taskId);
        if (!entry) {
          return { ok: false, message: `No MCP background task ${taskId}.` };
        }
        if (entry.status === "running") {
          entry.abort();
          this.settle(taskId, "killed");
        }
        return {
          ok: true,
          message: `Stopped MCP background task ${taskId}.`,
          snapshot: this.toSnapshot(this.tasks.get(taskId)),
        };
      },
    };
  }

  /** Record a newly backgrounded call. `abort` hard-stops the underlying call. */
  add(description: string, abort: () => void): string {
    const id = `mcp-bg-${Date.now()}-${++this.seq}`;
    this.tasks.set(id, { id, description, status: "running", startedAt: Date.now(), abort });
    return id;
  }

  /** Move a task to a terminal state. No-op once already terminal. */
  settle(taskId: string, status: McpBackgroundStatus, error?: string): void {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.status !== "running") return;
    entry.status = status;
    entry.endedAt = Date.now();
    if (error) entry.error = error;
  }

  snapshot(taskId: string): McpBackgroundSnapshot | undefined {
    return this.toSnapshot(this.tasks.get(taskId));
  }
}

export interface AutoBackgroundOutcome<T> {
  backgrounded: boolean;
  /** Present when not backgrounded (the tool finished within the threshold). */
  result?: T;
  /** Present when backgrounded. */
  taskId?: string;
}

/**
 * Race a tool-call promise against the auto-background threshold.
 *
 * - `ms <= 0`: never background; resolve with the awaited result.
 * - promise settles first: resolve/reject as the underlying call did.
 * - timer fires first: call `onBackground()` (which registers the task and
 *   returns its id), attach a detached settle to the still-running promise
 *   (writes ONLY to the store — never re-resolves `execute`, so no
 *   double-resolve / orphan), and resolve as backgrounded.
 */
export function raceAutoBackground<T>(
  promise: Promise<T>,
  opts: {
    ms: number;
    onBackground: () => string;
    settle: (taskId: string, status: McpBackgroundStatus, error?: string) => void;
    timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
  },
): Promise<AutoBackgroundOutcome<T>> {
  if (opts.ms <= 0) {
    return promise.then((result) => ({ backgrounded: false, result }));
  }
  const setTimer = opts.timers?.set ?? setTimeout;
  const clearTimer = opts.timers?.clear ?? clearTimeout;
  return new Promise<AutoBackgroundOutcome<T>>((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      const taskId = opts.onBackground();
      promise.then(
        () => opts.settle(taskId, "completed"),
        (err) => opts.settle(taskId, "failed", err instanceof Error ? err.message : String(err)),
      );
      resolve({ backgrounded: true, taskId });
    }, opts.ms);
    promise.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve({ backgrounded: false, result });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(err);
      },
    );
  });
}
