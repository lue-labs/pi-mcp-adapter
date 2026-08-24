// mcp-bg-tasks.ts — auto-background hung MCP tool calls (my-pi #1091, CC 2.1.212 parity).
//
// A hung MCP tool call is a *promise*, not a process: unlike a background bash
// job there is no PID to detach and no log file to tail. When a call exceeds the
// threshold we stop *awaiting* it in the foreground, hand the single in-flight
// promise to a small in-process registry that attaches the *only* remaining
// settle handler, and return a model-visible note so the turn continues. The
// promise keeps running; on settle we fire a task-notification wake and (if the
// running pi build exposes the task-registry seam) surface it to TaskStop /
// TaskBackgroundList.
//
// Correctness invariants (see __tests__/mcp-bg-tasks.test.ts):
//   * The call promise is consumed exactly once. Either the foreground race
//     resolves/rejects it in time, OR it is detached and the registry attaches
//     the sole .then/.catch. It never gets two competing consumers, so it can
//     neither be orphaned (unhandled rejection) nor double-resolved.
//   * The per-call cleanup callback (decrement in-flight / touch / UI teardown)
//     runs exactly once, on whichever path wins.
//   * A user-initiated TaskStop aborts the call and stays silent (no completion
//     wake) — mirroring bash-bg's "deliberate stops don't re-notify" rule.

/** Env override for the auto-background threshold (CC-compatible name). */
export const MCP_AUTO_BACKGROUND_ENV = "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS";
/** Default threshold: 120s, matching Claude Code's `Wc_`. */
export const DEFAULT_MCP_AUTO_BACKGROUND_MS = 120_000;

/**
 * IDE-provided MCP servers are exempt from auto-background: their calls are
 * long-lived interactive channels, not hung work. Matches Claude Code's
 * `sse-ide` / `ws-ide` server ids.
 */
export const IDE_EXEMPT_SERVER_NAMES = new Set(["sse-ide", "ws-ide"]);

/** Resolve the threshold from the environment. `<= 0` disables auto-background. */
export function resolveAutoBackgroundMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MCP_AUTO_BACKGROUND_ENV];
  if (raw === undefined || raw === "") return DEFAULT_MCP_AUTO_BACKGROUND_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MCP_AUTO_BACKGROUND_MS;
  return parsed;
}

/** True when this server must never be auto-backgrounded (IDE channels). */
export function isAutoBackgroundExempt(serverName: string): boolean {
  return IDE_EXEMPT_SERVER_NAMES.has(serverName.toLowerCase());
}

export type McpBgTaskStatus = "running" | "completed" | "failed" | "killed";

export interface McpBgTask {
  id: string;
  serverName: string;
  toolName: string;
  description: string;
  startedAt: number;
  endedAt?: number;
  status: McpBgTaskStatus;
  /** Rendered result text once the call settles successfully. */
  resultText?: string;
  error?: string;
  /** Abort the underlying MCP request (TaskStop / session dispose). */
  abort: () => void;
}

/** Minimal shape of the core task-registry seam we consume when present. */
interface TaskSnapshotLike {
  id: string;
  type: string;
  status: "running" | "completed" | "failed" | "killed";
  description: string;
  startedAt: number;
  endedAt?: number;
  resumable: boolean;
  error?: string;
}

const tasks = new Map<string, McpBgTask>();

let seq = 0;
function nextTaskId(): string {
  seq += 1;
  return `mcp_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/**
 * Process-wide completion notifier, wired from the extension entrypoint where
 * `pi.sendMessage` is available. Fires a task-notification wake so a CC-trained
 * model doesn't park forever waiting on a detached call. Defaults to a no-op so
 * the registry works in unit tests / older builds without a session.
 */
export type McpCompletionNotifier = (task: McpBgTask) => void;
let completionNotifier: McpCompletionNotifier | undefined;
export function setMcpCompletionNotifier(notifier: McpCompletionNotifier | undefined): void {
  completionNotifier = notifier;
}
export function getMcpCompletionNotifier(): McpCompletionNotifier | undefined {
  return completionNotifier;
}

/**
 * Build the task-notification message for a settled background MCP call,
 * mirroring pi's `<task_notification>` bash-completion envelope.
 */
export function renderMcpCompletionMessage(task: McpBgTask): string {
  const elapsedS = task.endedAt ? ((task.endedAt - task.startedAt) / 1000).toFixed(1) : "?";
  const lines = [
    "<task_notification>",
    `<task_id>${task.id}</task_id>`,
    "<task_type>background_mcp</task_type>",
    `<status>${task.status}</status>`,
    `<server>${task.serverName}</server>`,
    `<tool>${task.toolName}</tool>`,
    `<elapsed_s>${elapsedS}</elapsed_s>`,
  ];
  if (task.error) lines.push(`<error>${task.error}</error>`);
  lines.push("</task_notification>");
  const verb = task.status === "completed" ? "finished" : task.status;
  lines.push(
    `\nBackground MCP task ${task.id} (${task.serverName}/${task.toolName}) ${verb}. ` +
      `Read its result with TaskBackgroundList — do NOT re-call the tool to "check".`,
  );
  return lines.join("\n");
}

export function getMcpBgTask(id: string): McpBgTask | undefined {
  return tasks.get(id);
}

export function listMcpBgTasks(): McpBgTask[] {
  return [...tasks.values()];
}

/** Test-only: drop all tracked tasks. */
export function clearMcpBgTasksForTests(): void {
  tasks.clear();
  seq = 0;
}

function mapStatus(status: McpBgTaskStatus): TaskSnapshotLike["status"] {
  return status;
}

function snapshotOf(task: McpBgTask): TaskSnapshotLike {
  return {
    id: task.id,
    type: "local_mcp",
    status: mapStatus(task.status),
    description: task.description,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    resumable: false,
    error: task.error,
  };
}

// The Task adapter registered into pi's unified task registry when the running
// build exposes it. Kept `any`-typed at the boundary because the seam is not in
// every published @earendil-works/pi-coding-agent yet; at runtime in a pi build
// that has it, TaskStop / TaskBackgroundList light up. Where it is absent the
// feature still backgrounds calls and fires completion wakes via sendMessage.
const mcpTaskAdapter = {
  type: "local_mcp" as const,
  snapshot(taskId: string): TaskSnapshotLike | undefined {
    const task = tasks.get(taskId);
    return task ? snapshotOf(task) : undefined;
  },
  list(): TaskSnapshotLike[] {
    return [...tasks.values()].map(snapshotOf);
  },
  async output(taskId: string): Promise<{ text: string } | undefined> {
    const task = tasks.get(taskId);
    if (!task) return undefined;
    const header = `MCP ${task.serverName}/${task.toolName} — ${task.status}`;
    const body = task.status === "running"
      ? "(still running in the background)"
      : task.error
        ? `Error: ${task.error}`
        : task.resultText ?? "(empty result)";
    return { text: `${header}\n${body}` };
  },
  async kill(taskId: string): Promise<{ ok: boolean; message: string; snapshot?: TaskSnapshotLike }> {
    const task = tasks.get(taskId);
    if (!task) return { ok: false, message: `No MCP background task ${taskId}` };
    if (task.status !== "running") {
      return { ok: true, message: `${taskId} already ${task.status}`, snapshot: snapshotOf(task) };
    }
    task.abort();
    return { ok: true, message: `Stopping ${taskId}`, snapshot: snapshotOf(task) };
  },
};

let adapterRegistered = false;
/**
 * Register the MCP task adapter into pi's unified task registry, if the running
 * build exports the seam. Idempotent and best-effort — a missing seam only means
 * TaskStop/TaskBackgroundList won't see MCP tasks; backgrounding + wakes still
 * work. Dynamic import keeps the extension buildable against pi releases that
 * predate the seam.
 */
export async function ensureMcpTaskAdapterRegistered(): Promise<void> {
  if (adapterRegistered) return;
  adapterRegistered = true;
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as {
      registerTaskAdapter?: (adapter: unknown) => void;
    };
    mod.registerTaskAdapter?.(mcpTaskAdapter);
  } catch {
    // Seam unavailable in this build; degrade gracefully.
  }
}

/** Model-visible note injected when a call is detached to the background. */
export function detachNote(taskId: string, serverName: string, toolName: string, thresholdMs: number): string {
  return (
    `The MCP tool \`${toolName}\` on server \`${serverName}\` exceeded ${Math.round(thresholdMs / 1000)}s ` +
    `and was moved to the background as task \`${taskId}\`. The turn continues; you'll be notified when it finishes. ` +
    `Stop it with TaskStop(task_id="${taskId}"). Note: this background task does NOT survive exiting this session.`
  );
}

export interface AutoBackgroundDeps {
  serverName: string;
  toolName: string;
  thresholdMs: number;
  /** Invoke the underlying MCP call. Receives the abort signal to wire cancellation. */
  call: (signal: AbortSignal) => Promise<unknown>;
  /** Render a settled result into the text stored on the task / notification. */
  renderResult: (result: unknown) => string;
  /** Runs exactly once when the call settles or is detached-then-settles. */
  cleanup: () => void;
  /** Fire a model-visible completion wake (pi.sendMessage). Skipped on user-kill. */
  notifyCompletion?: (task: McpBgTask) => void;
  /** Test seam: clock override. */
  now?: () => number;
}

export type AutoBackgroundOutcome =
  | { kind: "resolved"; value: unknown }
  | { kind: "rejected"; error: unknown }
  | { kind: "backgrounded"; taskId: string; note: string };

const TIMEOUT = Symbol("mcp-auto-background-timeout");

/**
 * Race an MCP call against the threshold. Resolves/rejects in the foreground if
 * it settles in time; otherwise detaches it into the background registry and
 * returns a note. `cleanup` runs exactly once on the winning path.
 */
export async function callWithAutoBackground(deps: AutoBackgroundDeps): Promise<AutoBackgroundOutcome> {
  const now = deps.now ?? Date.now;
  const controller = new AbortController();
  const promise = deps.call(controller.signal);

  // A single guard shared by both the foreground finally and the background
  // settle handler guarantees `cleanup` fires exactly once regardless of which
  // path wins the race.
  let cleaned = false;
  const runCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      deps.cleanup();
    } catch {
      // cleanup must never mask the tool result.
    }
  };

  // Auto-background disabled or exempt → straight await, foreground semantics.
  if (deps.thresholdMs <= 0) {
    try {
      const value = await promise;
      runCleanup();
      return { kind: "resolved", value };
    } catch (error) {
      runCleanup();
      return { kind: "rejected", error };
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), deps.thresholdMs);
  });

  // The race observes `promise`; observing does not consume its settlement for
  // the detach path — we still attach the sole terminal handler below.
  let raced: unknown;
  try {
    raced = await Promise.race([
      promise.then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error })),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (raced !== TIMEOUT) {
    // Settled before threshold — foreground path owns cleanup.
    runCleanup();
    const settled = raced as { ok: true; value: unknown } | { ok: false; error: unknown };
    if (settled.ok) return { kind: "resolved", value: settled.value };
    return { kind: "rejected", error: (settled as { ok: false; error: unknown }).error };
  }

  // Timed out → detach. Register the task and attach the ONLY remaining terminal
  // handler to the original promise. No second consumer exists, so the promise
  // can neither leak an unhandled rejection nor be double-resolved.
  const taskId = nextTaskId();
  const task: McpBgTask = {
    id: taskId,
    serverName: deps.serverName,
    toolName: deps.toolName,
    description: `${deps.serverName}/${deps.toolName}`,
    startedAt: now(),
    status: "running",
    abort: () => {
      if (task.status === "running") {
        task.status = "killed";
        task.endedAt = now();
      }
      try {
        controller.abort();
      } catch {
        // best-effort
      }
    },
  };
  tasks.set(taskId, task);
  void ensureMcpTaskAdapterRegistered();

  const settle = (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => {
    const killedByUser = task.status === "killed";
    if (task.status === "running") {
      task.status = outcome.ok ? "completed" : "failed";
      task.endedAt = now();
    }
    if (outcome.ok) {
      task.resultText = deps.renderResult(outcome.value);
    } else {
      const err = (outcome as { ok: false; error: unknown }).error;
      task.error = err instanceof Error ? err.message : String(err);
    }
    runCleanup();
    // Deliberate TaskStop stays silent — the model already knows it stopped it.
    if (!killedByUser) (deps.notifyCompletion ?? completionNotifier)?.(task);
  };
  promise.then(
    (value) => settle({ ok: true, value }),
    (error) => settle({ ok: false, error }),
  );

  return { kind: "backgrounded", taskId, note: detachNote(taskId, deps.serverName, deps.toolName, deps.thresholdMs) };
}
