import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  formatDirectToolUnavailabilityMessage,
  getConfiguredDirectToolCacheGaps,
  getMissingConfiguredDirectToolServers,
  resolveDirectTools,
} from "../direct-tools.ts";
import {
  CACHE_MAX_AGE_MS,
  computeServerHash,
  loadMetadataCache,
  saveMetadataCache,
  type MetadataCache,
} from "../metadata-cache.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpConfig, ServerEntry } from "../types.ts";

const mocks = vi.hoisted(() => ({
  loadMcpConfig: vi.fn(),
}));

vi.mock("../config.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  loadMcpConfig: mocks.loadMcpConfig,
}));

const fixture = fileURLToPath(new URL("./fixtures/direct-tools-cache-server.mjs", import.meta.url));
const SECRET = "s3cr3t-mcp-cache-token-value";
const STALE_TOOL = "stale_should_not_appear";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

const states: Array<{
  lifecycle: { gracefulShutdown: () => Promise<void> };
  manager: { getConnection: (name: string) => unknown };
}> = [];

function fixtureDefinition(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    command: process.execPath,
    args: [fixture],
    env: { SECRET_TOKEN: SECRET },
    directTools: ["search", "list"],
    ...overrides,
  };
}

function crashingDefinition(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
    env: { SECRET_TOKEN: SECRET },
    directTools: true,
    ...overrides,
  };
}

function cacheFor(name: string, definition: ServerEntry, tools: Array<{ name: string; description?: string }>): MetadataCache {
  return {
    version: 1,
    servers: {
      [name]: {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools,
        resources: [],
      },
    },
  };
}

function extensionApi(): ExtensionAPI {
  return {
    getFlag: vi.fn(() => undefined),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
}

function context(hasUI: boolean): { ctx: ExtensionContext; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const ctx = {
    cwd: "/tmp/mcp-cache-diagnostics-project",
    hasUI,
    mode: hasUI ? "tui" : "rpc",
    ui: hasUI
      ? { select: vi.fn(), input: vi.fn(), notify } as unknown as ExtensionUIContext
      : undefined,
    modelRegistry: {},
    model: undefined,
    signal: undefined,
  } as unknown as ExtensionContext;
  return { ctx, notify };
}

function diagnosticText(warn: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>, notify?: ReturnType<typeof vi.fn>): string {
  return [
    ...warn.mock.calls.map(args => String(args[0])),
    ...error.mock.calls.map(args => String(args[0])),
    ...(notify?.mock.calls ?? []).map(args => String(args[0])),
  ].join("\n");
}

function newDiagnosticText(warn: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>, notify?: ReturnType<typeof vi.fn>): string {
  return diagnosticText(warn, error, notify)
    .split("\n")
    .filter(line => line.includes("configured direct tools unavailable"))
    .join("\n");
}

describe("direct-tool cache diagnostics", () => {
  let agentDir = "";
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "mcp-cache-diag-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.MCP_DIRECT_TOOLS;
    mocks.loadMcpConfig.mockReset();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    const pending = states.splice(0);
    await Promise.all(pending.map(state => state.lifecycle.gracefulShutdown().catch(() => undefined)));
    warn.mockRestore();
    error.mockRestore();
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
    await rm(agentDir, { recursive: true, force: true });
  });

  describe("gap helpers", () => {
    it("treats omitted cache and hash mismatch as gaps without using stale tool names", () => {
      const definition = fixtureDefinition();
      const config: McpConfig = {
        mcpServers: { demo: definition },
      };
      const stale: MetadataCache = {
        version: 1,
        servers: {
          demo: {
            configHash: "not-the-current-hash",
            cachedAt: Date.now(),
            tools: [{ name: STALE_TOOL, description: "stale" }],
            resources: [],
          },
        },
      };

      expect(getMissingConfiguredDirectToolServers(config, null)).toEqual(["demo"]);
      expect(getConfiguredDirectToolCacheGaps(config, null)).toEqual([
        { serverName: "demo", reason: "missing-cache", configuredTools: ["search", "list"] },
      ]);
      expect(getConfiguredDirectToolCacheGaps(config, stale)).toEqual([
        { serverName: "demo", reason: "invalid-cache", configuredTools: ["search", "list"] },
      ]);
      expect(resolveDirectTools(config, stale, "server")).toEqual([]);
    });

    it("keeps unknown names unknown when directTools is true", () => {
      const config: McpConfig = {
        mcpServers: { demo: crashingDefinition() },
      };
      const gaps = getConfiguredDirectToolCacheGaps(config, null);
      expect(gaps).toEqual([{ serverName: "demo", reason: "missing-cache", configuredTools: true }]);
      const message = formatDirectToolUnavailabilityMessage(gaps[0]!, { serverName: "demo", status: "warmed" }).message;
      expect(message).toContain("configured tool names unknown until discovery");
      expect(message).not.toContain(STALE_TOOL);
    });

    it("preserves a global directTools array and per-server true/false overrides without quoting stale names", () => {
      const staleEntry = {
        configHash: "stale-hash",
        cachedAt: Date.now(),
        tools: [{ name: STALE_TOOL, description: "stale" }],
        resources: [] as [],
      };
      const config: McpConfig = {
        settings: { directTools: ["search"] },
        mcpServers: {
          fromGlobal: { command: process.execPath, args: ["-e", "process.exit(1)"] },
          optedOut: { command: process.execPath, args: ["-e", "process.exit(1)"], directTools: false },
          allTools: { command: process.execPath, args: ["-e", "process.exit(1)"], directTools: true },
          named: { command: process.execPath, args: ["-e", "process.exit(1)"], directTools: ["list"] },
        },
      };
      const stale: MetadataCache = {
        version: 1,
        servers: {
          fromGlobal: staleEntry,
          optedOut: staleEntry,
          allTools: staleEntry,
          named: staleEntry,
        },
      };

      expect(getConfiguredDirectToolCacheGaps(config, stale)).toEqual([
        { serverName: "fromGlobal", reason: "invalid-cache", configuredTools: ["search"] },
        { serverName: "allTools", reason: "invalid-cache", configuredTools: true },
        { serverName: "named", reason: "invalid-cache", configuredTools: ["list"] },
      ]);
      const messages = getConfiguredDirectToolCacheGaps(config, stale).map(
        gap => formatDirectToolUnavailabilityMessage(gap, { serverName: gap.serverName, status: "warmed" }).message,
      );
      expect(messages.join("\n")).toContain("configured tools: search");
      expect(messages.join("\n")).toContain("configured tools: list");
      expect(messages.join("\n")).toContain("configured tool names unknown until discovery");
      expect(messages.join("\n")).not.toContain(STALE_TOOL);
      expect(messages.join("\n")).not.toContain("optedOut");
    });

    it("describes same-hash expired cache as expired, not a hash mismatch", () => {
      const definition = fixtureDefinition();
      const config: McpConfig = {
        mcpServers: { demo: definition },
      };
      const expired: MetadataCache = {
        version: 1,
        servers: {
          demo: {
            configHash: computeServerHash(definition),
            cachedAt: Date.now() - CACHE_MAX_AGE_MS - 1,
            tools: [{ name: STALE_TOOL, description: "stale" }],
            resources: [],
          },
        },
      };

      expect(getConfiguredDirectToolCacheGaps(config, expired)).toEqual([
        { serverName: "demo", reason: "expired-cache", configuredTools: ["search", "list"] },
      ]);
      const message = formatDirectToolUnavailabilityMessage(
        getConfiguredDirectToolCacheGaps(config, expired)[0]!,
        { serverName: "demo", status: "warmed" },
      ).message;
      expect(message).toContain("metadata cache expired");
      expect(message).not.toContain("config hash does not match cache");
      expect(message).not.toContain(STALE_TOOL);
      expect(resolveDirectTools(config, expired, "server")).toEqual([]);
    });
  });

  describe("initializeMcp lifecycle", () => {
    async function runInit(config: McpConfig, hasUI: boolean) {
      mocks.loadMcpConfig.mockReturnValue(config);
      const { initializeMcp } = await import("../init.ts");
      const { ctx, notify } = context(hasUI);
      const state = await initializeMcp(extensionApi(), ctx);
      states.push(state);
      return { state, notify };
    }

    it("stays silent for a valid cache and does not spawn the server", async () => {
      const definition = crashingDefinition({ directTools: ["search"] });
      const config: McpConfig = {
        settings: { idleTimeout: 0 },
        mcpServers: { demo: definition },
      };
      saveMetadataCache(cacheFor("demo", definition, [{ name: "search", description: "Search items" }]));

      const { notify } = await runInit(config, false);
      const text = diagnosticText(warn, error, notify);

      expect(text).not.toContain("configured direct tools unavailable");
      expect(getMissingConfiguredDirectToolServers(config, loadMetadataCache())).toEqual([]);
      expect(resolveDirectTools(config, loadMetadataCache(), "server").map(spec => spec.originalName)).toEqual(["search"]);
      expect(states[0]?.manager.getConnection("demo")).toBeUndefined();
    });

    it("reports a first-session cache miss, warms metadata, and requires restart", async () => {
      const definition = fixtureDefinition();
      const config: McpConfig = {
        settings: { idleTimeout: 0 },
        mcpServers: { demo: definition },
      };

      const { notify } = await runInit(config, false);
      const text = diagnosticText(warn, error, notify);

      expect(text).toContain('"demo"');
      expect(text).toContain("configured tools: search, list");
      expect(text).toContain("Metadata warm succeeded; restart to register them.");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(STALE_TOOL);
      expect(getMissingConfiguredDirectToolServers(config, loadMetadataCache())).toEqual([]);
      expect(resolveDirectTools(config, loadMetadataCache(), "server").map(spec => spec.originalName)).toEqual(["search", "list"]);
    });

    it("reports config-hash invalidation without treating stale cache names as authoritative", async () => {
      const previous = fixtureDefinition({ args: [fixture, "--tools", "old"] });
      const current = fixtureDefinition();
      const config: McpConfig = {
        settings: { idleTimeout: 0 },
        mcpServers: { demo: current },
      };
      saveMetadataCache({
        version: 1,
        servers: {
          demo: {
            configHash: computeServerHash(previous),
            cachedAt: Date.now(),
            tools: [{ name: STALE_TOOL, description: "stale" }],
            resources: [],
          },
        },
      });

      const { notify } = await runInit(config, true);
      const text = diagnosticText(warn, error, notify);

      expect(text).toContain("config hash does not match cache");
      expect(text).toContain("configured tools: search, list");
      expect(text).toContain("Metadata warm succeeded; restart to register them.");
      expect(text).not.toContain(STALE_TOOL);
      expect(text).not.toContain(SECRET);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Metadata warm succeeded"), "warning");
      expect(resolveDirectTools(config, loadMetadataCache(), "server").map(spec => spec.originalName)).toEqual(["search", "list"]);
    });

    it("honors explicit MCP_DIRECT_TOOLS=__none__ with no warm and no diagnostic", async () => {
      process.env.MCP_DIRECT_TOOLS = "__none__";
      const definition = crashingDefinition();
      const config: McpConfig = {
        settings: { idleTimeout: 0 },
        mcpServers: { demo: definition },
      };
      saveMetadataCache({ version: 1, servers: {} });

      const { notify } = await runInit(config, false);
      const text = diagnosticText(warn, error, notify);

      expect(text).not.toContain("configured direct tools unavailable");
      expect(getMissingConfiguredDirectToolServers(config, loadMetadataCache())).toEqual(["demo"]);
      expect(states[0]?.manager.getConnection("demo")).toBeUndefined();
    });

    it("reports same-hash expired cache without calling it a hash mismatch", async () => {
      const definition = fixtureDefinition();
      const config: McpConfig = {
        settings: { idleTimeout: 0 },
        mcpServers: { demo: definition },
      };
      saveMetadataCache({
        version: 1,
        servers: {
          demo: {
            configHash: computeServerHash(definition),
            cachedAt: Date.now() - CACHE_MAX_AGE_MS - 1,
            tools: [{ name: STALE_TOOL, description: "stale" }],
            resources: [],
          },
        },
      });

      const { notify } = await runInit(config, true);
      const text = newDiagnosticText(warn, error, notify);

      expect(text).toContain("metadata cache expired");
      expect(text).not.toContain("config hash does not match cache");
      expect(text).toContain("configured tools: search, list");
      expect(text).toContain("Metadata warm succeeded; restart to register them.");
      expect(text).not.toContain(STALE_TOOL);
      expect(text).not.toContain(SECRET);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("metadata cache expired"), "warning");
    });

    it("reports failed discovery without leaking secrets", async () => {
      const definition = crashingDefinition({ directTools: ["search"] });
      const config: McpConfig = {
        settings: { idleTimeout: 0 },
        mcpServers: { demo: definition },
      };
      saveMetadataCache({ version: 1, servers: {} });

      const { notify } = await runInit(config, false);
      const text = newDiagnosticText(warn, error, notify);

      expect(text).toContain('"demo"');
      expect(text).toContain("Discovery failed: could not discover tools");
      expect(text).toContain("/mcp reconnect demo");
      expect(text).toContain("configured tools: search");
      expect(text).not.toContain(SECRET);
      expect(getMissingConfiguredDirectToolServers(config, loadMetadataCache())).toEqual(["demo"]);
    });

    it("does not interpolate untrusted connect error text into the new diagnostic", async () => {
      const leakPassword = "leak-password";
      const leakQuery = "leak-query-token";
      const leakBody = "HTTP_BODY_SENTINEL_DO_NOT_ECHO";
      const connectError = new Error(
        `fetch failed: https://user:${leakPassword}@evil.example/mcp?token=${leakQuery} body=${leakBody}\n    at Client.connect (sdk.js:1:1)`,
      );
      const connectSpy = vi.spyOn(McpServerManager.prototype, "connect").mockRejectedValue(connectError);
      try {
        const definition = crashingDefinition({ directTools: ["search"] });
        const config: McpConfig = {
          settings: { idleTimeout: 0 },
          mcpServers: { demo: definition },
        };
        saveMetadataCache({ version: 1, servers: {} });

        const { notify } = await runInit(config, true);
        const text = newDiagnosticText(warn, error, notify);

        expect(text).toContain('"demo"');
        expect(text).toContain("Discovery failed: could not discover tools");
        expect(text).toContain("Check the server command or URL");
        expect(text).toContain("/mcp reconnect demo");
        expect(notify).toHaveBeenCalledWith(expect.stringContaining("Discovery failed: could not discover tools"), "error");
        expect(text).not.toContain(leakPassword);
        expect(text).not.toContain(leakQuery);
        expect(text).not.toContain(leakBody);
        expect(text).not.toContain("user:");
        expect(text).not.toContain("evil.example");
        expect(text).not.toContain("sdk.js");
        expect(text).not.toContain("fetch failed");
      } finally {
        connectSpy.mockRestore();
      }
    });

    it("reports auth discovery failure distinctly from a successful warm", async () => {
      const gap = {
        serverName: "demo",
        reason: "missing-cache" as const,
        configuredTools: ["search"],
      };
      const auth = formatDirectToolUnavailabilityMessage(gap, { serverName: "demo", status: "needs-auth" });
      const warmed = formatDirectToolUnavailabilityMessage(gap, { serverName: "demo", status: "warmed" });

      expect(auth.level).toBe("error");
      expect(auth.message).toContain("Discovery failed: OAuth authentication required. Run /mcp-auth demo.");
      expect(auth.message).not.toContain("Metadata warm succeeded");
      expect(warmed.level).toBe("warn");
      expect(warmed.message).toContain("Metadata warm succeeded; restart to register them.");
      expect(warmed.message).not.toContain("Discovery failed");
    });
  });
});
