import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "direct-tools-cache-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

const defaultTools = [
  {
    name: "search",
    description: "Search items",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
  {
    name: "list",
    description: "List items",
    inputSchema: { type: "object", properties: {} },
  },
];
// `--tools=a,b` replaces the default tools (e.g. to expose a builtin-colliding "read").
const toolsArg = process.argv.find(arg => arg.startsWith("--tools="));
const tools = toolsArg
  ? toolsArg.slice("--tools=".length).split(",").filter(Boolean)
    .map(name => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } }))
  : defaultTools;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "ok" }],
}));

await server.connect(new StdioServerTransport());
