import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolLoading, DirectToolSpec, McpConfig, McpContent } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { lazyConnect, getFailureAgeSeconds } from "./init.ts";
import { isServerCacheValid } from "./metadata-cache.ts";
import { formatSchema } from "./tool-metadata.ts";
import { transformMcpContent } from "./tool-registrar.ts";
import { maybeStartUiSession, type UiSessionRuntime } from "./ui-session.ts";
import { formatToolName, isToolExcluded } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { authenticate, supportsOAuth } from "./mcp-auth-flow.ts";
import { formatAuthRequiredMessage } from "./utils.ts";
import {
  callWithAutoBackground,
  isAutoBackgroundExempt,
  resolveAutoBackgroundMs,
} from "./mcp-bg-tasks.ts";

type CallToolResult = import("@modelcontextprotocol/sdk/types.js").CallToolResult;

/** Flatten an MCP CallToolResult's text content for a background task's stored result / notification. */
function renderCallToolText(result: unknown): string {
  const content = ((result as { content?: McpContent[] } | undefined)?.content ?? []) as McpContent[];
  const text = content
    .filter(c => c.type === "text")
    .map(c => (c as { text: string }).text)
    .join("\n");
  return text || "(empty result)";
}

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);

function normalizeDirectToolLoading(value: unknown): DirectToolLoading | undefined {
  return value === "eager" || value === "deferred" ? value : undefined;
}

type DirectAutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

function getDirectAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
): string {
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getDirectAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  if (customGuidance) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getDirectAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`;
}

async function attemptDirectAutoAuth(
  state: McpExtensionState,
  serverName: string,
): Promise<DirectAutoAuthResult> {
  if (state.config.settings?.autoAuth !== true) {
    return { status: "skipped" };
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition || !supportsOAuth(definition) || !definition.url) {
    return { status: "skipped" };
  }

  const grantType = definition.oauth ? definition.oauth.grantType ?? "authorization_code" : "authorization_code";
  if (!state.ui && grantType !== "client_credentials") {
    return {
      status: "failed",
      message: getDirectAuthRequiredMessage(
        state,
        serverName,
        `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
      ),
    };
  }

  try {
    await authenticate(serverName, definition.url, definition);
    return { status: "success" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: getDirectAuthFailedMessage(state, serverName, message),
    };
  }
}

export function resolveDirectTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: "server" | "none" | "short",
  envOverride?: string[],
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  if (!cache) return specs;

  const seenNames = new Set<string>();

  const envServers = new Set<string>();
  const envTools = new Map<string, Set<string>>();
  if (envOverride) {
    for (let item of envOverride) {
      item = item.replace(/\/+$/, "");
      if (item.includes("/")) {
        const [server, tool] = item.split("/", 2);
        if (server && tool) {
          if (!envTools.has(server)) envTools.set(server, new Set());
          envTools.get(server)!.add(tool);
        } else if (server) {
          envServers.add(server);
        }
      } else if (item) {
        envServers.add(item);
      }
    }
  }

  const globalDirect = config.settings?.directTools;
  const globalLoading = normalizeDirectToolLoading(config.settings?.directToolLoading) ?? "deferred";

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) continue;

    let toolFilter: true | string[] | false = false;

    if (envOverride) {
      if (envServers.has(serverName)) {
        toolFilter = true;
      } else if (envTools.has(serverName)) {
        toolFilter = [...envTools.get(serverName)!];
      }
    } else {
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }
    }

    if (!toolFilter) continue;

    const directToolLoading = normalizeDirectToolLoading(definition.directToolLoading) ?? globalLoading;

    for (const tool of serverCache.tools ?? []) {
      if (toolFilter !== true && !toolFilter.includes(tool.name)) continue;
      if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue;
      const prefixedName = formatToolName(tool.name, serverName, prefix);
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      if (seenNames.has(prefixedName)) {
        console.warn(`MCP: skipping duplicate direct tool "${prefixedName}" from "${serverName}"`);
        continue;
      }
      seenNames.add(prefixedName);
      specs.push({
        serverName,
        originalName: tool.name,
        prefixedName,
        description: tool.description ?? "",
        loading: directToolLoading,
        inputSchema: tool.inputSchema,
        uiResourceUri: tool.uiResourceUri,
        uiStreamMode: tool.uiStreamMode,
      });
    }

    if (definition.exposeResources !== false) {
      for (const resource of serverCache.resources ?? []) {
        const baseName = `get_${resourceNameToToolName(resource.name)}`;
        if (toolFilter !== true && !toolFilter.includes(baseName)) continue;
        if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) continue;
        const prefixedName = formatToolName(baseName, serverName, prefix);
        if (BUILTIN_NAMES.has(prefixedName)) {
          console.warn(`MCP: skipping direct resource tool "${prefixedName}" (collides with builtin)`);
          continue;
        }
        if (seenNames.has(prefixedName)) {
          console.warn(`MCP: skipping duplicate direct resource tool "${prefixedName}" from "${serverName}"`);
          continue;
        }
        seenNames.add(prefixedName);
        specs.push({
          serverName,
          originalName: baseName,
          prefixedName,
          description: resource.description ?? `Read resource: ${resource.uri}`,
          loading: directToolLoading,
          resourceUri: resource.uri,
        });
      }
    }
  }

  return specs;
}

export type DirectToolCacheMissReason = "missing-cache" | "invalid-cache";

export interface DirectToolCacheGap {
  serverName: string;
  reason: DirectToolCacheMissReason;
  /** Configured tool names when `directTools` is a string[]; `true` means all tools (names unknown). */
  configuredTools: true | string[];
}

export type DirectToolBootstrapOutcome =
  | { serverName: string; status: "warmed" }
  | { serverName: string; status: "needs-auth" }
  | { serverName: string; status: "failed"; message: string };

function configuredDirectToolFilter(
  config: McpConfig,
  serverName: string,
): true | string[] | false {
  const definition = config.mcpServers[serverName];
  if (!definition) return false;
  if (definition.directTools !== undefined) {
    if (!definition.directTools) return false;
    return definition.directTools;
  }
  return config.settings?.directTools ? true : false;
}

export function getConfiguredDirectToolCacheGaps(
  config: McpConfig,
  cache: MetadataCache | null,
): DirectToolCacheGap[] {
  const gaps: DirectToolCacheGap[] = [];

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const configuredTools = configuredDirectToolFilter(config, serverName);
    if (!configuredTools) continue;

    const serverCache = cache?.servers?.[serverName];
    if (!serverCache) {
      gaps.push({ serverName, reason: "missing-cache", configuredTools });
      continue;
    }
    if (!isServerCacheValid(serverCache, definition)) {
      gaps.push({ serverName, reason: "invalid-cache", configuredTools });
    }
  }

  return gaps;
}

export function getMissingConfiguredDirectToolServers(
  config: McpConfig,
  cache: MetadataCache | null,
): string[] {
  return getConfiguredDirectToolCacheGaps(config, cache).map(gap => gap.serverName);
}

export function formatDirectToolUnavailabilityMessage(
  gap: DirectToolCacheGap,
  outcome: DirectToolBootstrapOutcome,
): { level: "warn" | "error"; message: string } {
  const reason = gap.reason === "missing-cache"
    ? "no metadata cache"
    : "config hash does not match cache";
  const tools = gap.configuredTools === true
    ? "configured tool names unknown until discovery"
    : `configured tools: ${gap.configuredTools.join(", ")}`;
  const prefix = `MCP: configured direct tools unavailable this session for "${gap.serverName}" (${reason}; ${tools}).`;

  if (outcome.status === "warmed") {
    return {
      level: "warn",
      message: `${prefix} Metadata warm succeeded; restart to register them.`,
    };
  }
  if (outcome.status === "needs-auth") {
    return {
      level: "error",
      message: `${prefix} Discovery failed: OAuth authentication required. Run /mcp-auth ${gap.serverName}.`,
    };
  }
  return {
    level: "error",
    message: `${prefix} Discovery failed: ${outcome.message}`,
  };
}

export function buildProxyDescription(
  config: McpConfig,
  cache: MetadataCache | null,
  directSpecs: DirectToolSpec[],
): string {
  const prefix = config.settings?.toolPrefix ?? "server";
  let desc = `MCP gateway - connect to MCP servers and call their tools. Non-MCP Pi tools should be called directly, not through mcp.\n`;

  const directByServer = new Map<string, number>();
  for (const spec of directSpecs) {
    directByServer.set(spec.serverName, (directByServer.get(spec.serverName) ?? 0) + 1);
  }
  if (directByServer.size > 0) {
    const parts = [...directByServer.entries()].map(
      ([server, count]) => `${server} (${count})`,
    );
    desc += `\nDirect tools available (call as normal tools): ${parts.join(", ")}\n`;
  }

  const serverSummaries: string[] = [];
  for (const serverName of Object.keys(config.mcpServers)) {
    const entry = cache?.servers?.[serverName];
    const definition = config.mcpServers[serverName];
    const toolCount = (entry?.tools ?? []).filter(
      (tool) => !isToolExcluded(tool.name, serverName, prefix, definition.excludeTools),
    ).length;
    const resourceCount = definition?.exposeResources !== false
      ? (entry?.resources ?? []).filter((resource) => {
          const baseName = `get_${resourceNameToToolName(resource.name)}`;
          return !isToolExcluded(baseName, serverName, prefix, definition.excludeTools);
        }).length
      : 0;
    const totalItems = toolCount + resourceCount;
    if (totalItems === 0) continue;
    const directCount = directByServer.get(serverName) ?? 0;
    const proxyCount = totalItems - directCount;
    if (proxyCount > 0) {
      serverSummaries.push(`${serverName} (${proxyCount} tools)`);
    }
  }

  if (serverSummaries.length > 0) {
    desc += `\nServers: ${serverSummaries.join(", ")}\n`;
  }

  desc += `\nUsage:\n`;
  desc += `  mcp({ })                              → Show server status\n`;
  desc += `  mcp({ server: "name" })               → List tools from server\n`;
  desc += `  mcp({ search: "query" })              → Search MCP tools by name/description\n`;
  desc += `  mcp({ describe: "tool_name" })        → Show tool details and parameters\n`;
  desc += `  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n`;
  desc += `  mcp({ tool: "name", args: '{"key": "value"}' })    → Call a tool (args is JSON string)\n`;
  desc += `  mcp({ action: "ui-messages" })        → Retrieve accumulated messages from completed UI sessions\n`;
  desc += `  mcp({ action: "auth-start", server: "name" })      → Start manual OAuth and get a browser URL\n`;
  desc += `  mcp({ action: "auth-complete", server: "name", args: '{"redirectUrl":"..."}' }) → Complete manual OAuth\n`;
  desc += `\nMode: action > tool (call) > connect > describe > search > server (list) > nothing (status)`;

  return desc;
}

type DirectToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<Record<string, unknown>>>;

export function createDirectToolExecutor(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  spec: DirectToolSpec
): DirectToolExecute {
  return async function execute(_toolCallId, params) {
    let state = getState();
    const initPromise = getInitPromise();

    if (!state && initPromise) {
      try {
        state = await initPromise;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
          details: { error: "init_failed", message },
        };
      }
    }
    if (!state) {
      return {
        content: [{ type: "text" as const, text: "MCP not initialized" }],
        details: { error: "not_initialized" },
      };
    }

    let connected = await lazyConnect(state, spec.serverName);
    let autoAuthAttempted = false;

    if (!connected && state.manager.getConnection(spec.serverName)?.status === "needs-auth") {
      autoAuthAttempted = true;
      const autoAuth = await attemptDirectAutoAuth(state, spec.serverName);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { error: "auth_required", server: spec.serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await state.manager.close(spec.serverName);
        state.failureTracker.delete(spec.serverName);
        connected = await lazyConnect(state, spec.serverName);
      }
    }

    if (!connected) {
      const authConnection = state.manager.getConnection(spec.serverName);
      if (authConnection?.status === "needs-auth") {
        const message = getDirectAuthRequiredMessage(state, spec.serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "auth_required", server: spec.serverName, message, autoAuthAttempted },
        };
      }
      const failedAgo = getFailureAgeSeconds(state, spec.serverName);
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not available${failedAgo !== null ? ` (failed ${failedAgo}s ago)` : ""}` }],
        details: { error: "server_unavailable", server: spec.serverName },
      };
    }

    const connection = state.manager.getConnection(spec.serverName);
    if (!connection || connection.status !== "connected") {
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not connected` }],
        details: { error: "not_connected", server: spec.serverName },
      };
    }

    let uiSession: UiSessionRuntime | null = null;
    // When the call is routed through auto-background, in-flight accounting and
    // UI teardown move into that path's single-shot cleanup, so the shared
    // `finally` must not also decrement (which would happen while the call is
    // still running in the background).
    let callHandledByAutoBg = false;

    try {
      state.manager.touch(spec.serverName);
      state.manager.incrementInFlight(spec.serverName);

      if (spec.resourceUri) {
        const result = await connection.client.readResource({ uri: spec.resourceUri });
        const content = (result.contents ?? []).map(c => ({
          type: "text" as const,
          text: "text" in c ? c.text : ("blob" in c ? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]` : JSON.stringify(c)),
        }));
        return {
          content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }],
          details: { server: spec.serverName, resourceUri: spec.resourceUri },
        };
      }

      const hasUi = !!spec.uiResourceUri;
      uiSession = hasUi
        ? await maybeStartUiSession(state, {
            serverName: spec.serverName,
            toolName: spec.originalName,
            toolArgs: params ?? {},
            uiResourceUri: spec.uiResourceUri!,
            streamMode: spec.uiStreamMode,
          })
        : null;

      const thresholdMs = isAutoBackgroundExempt(spec.serverName) ? 0 : resolveAutoBackgroundMs();
      callHandledByAutoBg = true;
      const outcome = await callWithAutoBackground({
        serverName: spec.serverName,
        toolName: spec.originalName,
        thresholdMs,
        // Raise the SDK per-request timeout above the auto-background threshold
        // so the race — not the SDK's default 60s — governs when a slow call is
        // detached. Exempt (threshold<=0) calls keep the SDK default.
        call: (signal) =>
          connection.client.callTool(
            { name: spec.originalName, arguments: params ?? {}, _meta: uiSession?.requestMeta },
            undefined,
            thresholdMs > 0 ? { signal, timeout: thresholdMs + 60_000 } : { signal },
          ),
        renderResult: renderCallToolText,
        cleanup: () => {
          if (uiSession?.reused) uiSession.close();
          state.manager.decrementInFlight(spec.serverName);
          state.manager.touch(spec.serverName);
        },
      });

      if (outcome.kind === "backgrounded") {
        return {
          content: [{ type: "text" as const, text: outcome.note }],
          details: { backgrounded: true, taskId: outcome.taskId, server: spec.serverName, tool: spec.originalName },
        };
      }
      if (outcome.kind === "rejected") {
        // Reuse the shared catch below for error formatting / UI cancellation.
        throw outcome.error;
      }

      const result = outcome.value as CallToolResult;
      uiSession?.sendToolResult(result as unknown as CallToolResult);

      const mcpContent = (result.content ?? []) as McpContent[];
      const content = transformMcpContent(mcpContent);

      if (result.isError) {
        let errorText = content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("\n") || "Tool execution failed";
        if (spec.inputSchema) {
          errorText += `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}`;
        }
        return {
          content: [{ type: "text" as const, text: `Error: ${errorText}` }],
          details: { error: "tool_error", server: spec.serverName },
        };
      }

      const resultText = content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("\n") || "(empty result)";
      if (hasUi) {
        const uiMessage = uiSession?.reused
          ? "Updated the open UI."
          : "📺 Interactive UI is now open in your browser. I'll respond to your prompts and intents as you interact with it.";
        return {
          content: [{ type: "text" as const, text: `${resultText}\n\n${uiMessage}` }],
          details: { server: spec.serverName, tool: spec.originalName, uiOpen: true },
        };
      }

      return {
        content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
        details: { server: spec.serverName, tool: spec.originalName },
      };
    } catch (error) {
      if (error instanceof UrlElicitationRequiredError) {
        const action = await state.manager.handleUrlElicitationRequired(spec.serverName, error);
        const message = action === "accept"
          ? "The original MCP tool did not run. Complete the opened browser interaction, then retry the tool."
          : `The URL interaction was ${action === "decline" ? "declined" : "cancelled"}.`;
        uiSession?.sendToolCancelled(message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "url_elicitation_required", server: spec.serverName, action },
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      uiSession?.sendToolCancelled(message);
      let errorText = `Failed to call tool: ${message}`;
      if (spec.inputSchema) {
        errorText += `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}`;
      }
      return {
        content: [{ type: "text" as const, text: errorText }],
        details: { error: "call_failed", server: spec.serverName },
      };
    } finally {
      // Auto-background owns cleanup for the callTool path (foreground settle or
      // deferred background settle). Only run shared cleanup for the other paths
      // (resource reads, pre-call throws).
      if (!callHandledByAutoBg) {
        if (uiSession?.reused) {
          uiSession.close();
        }
        state.manager.decrementInFlight(spec.serverName);
        state.manager.touch(spec.serverName);
      }
    }
  };
}
