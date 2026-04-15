import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as dotenv from "dotenv";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import http from "http";
import { URL } from "url";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const N8N_BASE_URL = (process.env.N8N_BASE_URL || "").replace(/\/$/, "");
const N8N_API_KEY = process.env.N8N_API_KEY || "";
const MCP_TRANSPORT = process.env.MCP_TRANSPORT || "stdio";
const MCP_PORT = parseInt(process.env.MCP_PORT || "3000", 10);

const OAUTH_USER_EMAIL = process.env.OAUTH_USER_EMAIL || "";
const OAUTH_USER_PASSWORD = process.env.OAUTH_USER_PASSWORD || "";
const OAUTH_JWT_SECRET = process.env.OAUTH_JWT_SECRET || crypto.randomBytes(64).toString("hex");
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "n8n-mcp-client";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || crypto.randomBytes(32).toString("hex");
const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || "";
const OAUTH_TOKEN_EXPIRY = 3600;

if (!N8N_BASE_URL) {
  console.error("ERROR: N8N_BASE_URL environment variable is required (e.g., https://your-n8n.example.com)");
  process.exit(1);
}
if (!N8N_API_KEY) {
  console.error("ERROR: N8N_API_KEY environment variable is required");
  process.exit(1);
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

interface ErrorWithMessage { message: string }
function isErrorWithMessage(e: unknown): e is ErrorWithMessage {
  return typeof e === "object" && e !== null && "message" in e && typeof (e as Record<string, unknown>).message === "string";
}
function getErrorMessage(e: unknown): string {
  return isErrorWithMessage(e) ? e.message : String(e);
}

const authCodes = new Map<string, { clientId: string; redirectUri: string; codeChallenge?: string; codeChallengeMethod?: string; expiresAt: number }>();
const refreshTokens = new Map<string, { clientId: string; expiresAt: number }>();
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (!attempt || now - attempt.lastAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now });
    return true;
  }
  if (attempt.count >= MAX_LOGIN_ATTEMPTS) return false;
  attempt.count++;
  attempt.lastAttempt = now;
  return true;
}

function generateAccessToken(clientId: string): string {
  return jwt.sign({ client_id: clientId, type: "access" }, OAUTH_JWT_SECRET, { expiresIn: OAUTH_TOKEN_EXPIRY });
}

function generateRefreshToken(clientId: string): string {
  const token = crypto.randomBytes(48).toString("hex");
  refreshTokens.set(token, { clientId, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  return token;
}

function verifyRequestAuthentication(req: http.IncomingMessage): { ok: true } | { ok: false; status: number; message: string } {
  if (!OAUTH_USER_EMAIL || !OAUTH_USER_PASSWORD) return { ok: true };
  const header = req.headers["authorization"];
  if (!header) return { ok: false, status: 401, message: "Missing Authorization header" };
  if (!header.startsWith("Bearer ")) return { ok: false, status: 401, message: "Invalid authorization scheme" };
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, OAUTH_JWT_SECRET) as { type: string };
    if (payload.type !== "access") return { ok: false, status: 401, message: "Invalid token type" };
    return { ok: true };
  } catch {
    return { ok: false, status: 401, message: "Invalid or expired token" };
  }
}

// ─── n8n API client ───────────────────────────────────────────────────────────

async function n8nRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${N8N_BASE_URL}/api/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-N8N-API-KEY": N8N_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`n8n API error ${res.status}: ${text}`);
  }
  if (!text) return {};
  return JSON.parse(text);
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "n8n-mcp-server",
  version: "1.0.0",
});

// ════════════════════════════════════════════════════════════════════
// WORKFLOWS
// ════════════════════════════════════════════════════════════════════

server.tool(
  "list-workflows",
  "List all workflows. Supports filtering by active status, tags, and name.",
  {
    active: z.boolean().optional().describe("Filter by active/inactive status"),
    tags: z.string().optional().describe("Comma-separated list of tag names to filter by"),
    name: z.string().optional().describe("Filter by workflow name (partial match)"),
    limit: z.number().int().min(1).max(250).default(100).describe("Max number of results"),
    cursor: z.string().optional().describe("Pagination cursor from previous response"),
  },
  async ({ active, tags, name, limit, cursor }) => {
    const params = new URLSearchParams();
    if (active !== undefined) params.set("active", String(active));
    if (tags) params.set("tags", tags);
    if (name) params.set("name", name);
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const data = await n8nRequest("GET", `/workflows?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get-workflow",
  "Get a specific workflow by ID including all nodes, connections, and settings.",
  {
    id: z.string().describe("Workflow ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("GET", `/workflows/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create-workflow",
  "Create a new workflow. Provide a name and optionally nodes, connections, and settings.",
  {
    name: z.string().describe("Workflow name"),
    nodes: z.array(z.record(z.unknown())).optional().default([]).describe("Array of node objects"),
    connections: z.record(z.unknown()).optional().default({}).describe("Connections object mapping nodes"),
    settings: z.record(z.unknown()).optional().default({}).describe("Workflow settings (timezone, errorWorkflow, etc.)"),
    staticData: z.record(z.unknown()).optional().describe("Static data for the workflow"),
    tags: z.array(z.string()).optional().describe("Array of tag IDs to assign"),
  },
  async ({ name, nodes, connections, settings, staticData, tags }) => {
    const body: Record<string, unknown> = { name, nodes, connections, settings };
    if (staticData) body.staticData = staticData;
    if (tags) body.tags = tags.map((id) => ({ id }));
    const data = await n8nRequest("POST", "/workflows", body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update-workflow",
  "Update an existing workflow. Replaces the full workflow definition.",
  {
    id: z.string().describe("Workflow ID"),
    name: z.string().optional().describe("New workflow name"),
    nodes: z.array(z.record(z.unknown())).optional().describe("Updated nodes array"),
    connections: z.record(z.unknown()).optional().describe("Updated connections"),
    settings: z.record(z.unknown()).optional().describe("Updated workflow settings"),
    staticData: z.record(z.unknown()).optional().describe("Updated static data"),
    tags: z.array(z.string()).optional().describe("Array of tag IDs to assign"),
  },
  async ({ id, name, nodes, connections, settings, staticData, tags }) => {
    // Fetch current workflow first so we can do a partial update
    const current = (await n8nRequest("GET", `/workflows/${id}`)) as Record<string, unknown>;
    const body: Record<string, unknown> = {
      name: name ?? current.name,
      nodes: nodes ?? current.nodes,
      connections: connections ?? current.connections,
      settings: settings ?? current.settings,
    };
    if (staticData !== undefined) body.staticData = staticData;
    if (tags !== undefined) body.tags = tags.map((tid) => ({ id: tid }));
    const data = await n8nRequest("PUT", `/workflows/${id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "delete-workflow",
  "Delete a workflow permanently by ID.",
  {
    id: z.string().describe("Workflow ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("DELETE", `/workflows/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "activate-workflow",
  "Activate a workflow so it responds to triggers.",
  {
    id: z.string().describe("Workflow ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("POST", `/workflows/${id}/activate`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "deactivate-workflow",
  "Deactivate a workflow so it stops responding to triggers.",
  {
    id: z.string().describe("Workflow ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("POST", `/workflows/${id}/deactivate`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get-workflow-tags",
  "Get all tags assigned to a specific workflow.",
  {
    id: z.string().describe("Workflow ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("GET", `/workflows/${id}/tags`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update-workflow-tags",
  "Replace the tags on a workflow.",
  {
    id: z.string().describe("Workflow ID"),
    tagIds: z.array(z.string()).describe("Array of tag IDs to assign to the workflow"),
  },
  async ({ id, tagIds }) => {
    const data = await n8nRequest("PUT", `/workflows/${id}/tags`, tagIds.map((tid) => ({ id: tid })));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// EXECUTIONS
// ════════════════════════════════════════════════════════════════════

server.tool(
  "list-executions",
  "List workflow executions with optional filters.",
  {
    workflowId: z.string().optional().describe("Filter by workflow ID"),
    status: z.enum(["error", "success", "waiting", "running", "canceled"]).optional().describe("Filter by execution status"),
    includeData: z.boolean().optional().default(false).describe("Include full execution data in response"),
    limit: z.number().int().min(1).max(250).default(20).describe("Max number of results"),
    cursor: z.string().optional().describe("Pagination cursor"),
  },
  async ({ workflowId, status, includeData, limit, cursor }) => {
    const params = new URLSearchParams();
    if (workflowId) params.set("workflowId", workflowId);
    if (status) params.set("status", status);
    params.set("includeData", String(includeData));
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const data = await n8nRequest("GET", `/executions?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get-execution",
  "Get details of a specific execution by ID.",
  {
    id: z.number().int().describe("Execution ID"),
    includeData: z.boolean().optional().default(true).describe("Include full execution data"),
  },
  async ({ id, includeData }) => {
    const data = await n8nRequest("GET", `/executions/${id}?includeData=${includeData}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "delete-execution",
  "Delete a specific execution by ID.",
  {
    id: z.number().int().describe("Execution ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("DELETE", `/executions/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "run-workflow",
  "Trigger a manual execution of a workflow. The workflow must have a Manual Trigger or Webhook node.",
  {
    id: z.string().describe("Workflow ID"),
    inputData: z.record(z.unknown()).optional().describe("Input data to pass to the workflow as JSON"),
  },
  async ({ id, inputData }) => {
    const body: Record<string, unknown> = {};
    if (inputData) body.runData = inputData;
    const data = await n8nRequest("POST", `/workflows/${id}/run`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// CREDENTIALS
// ════════════════════════════════════════════════════════════════════

server.tool(
  "list-credentials",
  "List all credentials stored in n8n.",
  {
    limit: z.number().int().min(1).max(250).default(100).describe("Max number of results"),
    cursor: z.string().optional().describe("Pagination cursor"),
    includeData: z.boolean().optional().default(false).describe("Include decrypted credential data (requires owner permissions)"),
  },
  async ({ limit, cursor, includeData }) => {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    if (includeData) params.set("includeData", "true");
    const data = await n8nRequest("GET", `/credentials?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get-credential-schema",
  "Get the data schema for a specific credential type (e.g. 'githubApi', 'slackApi', 'httpBasicAuth').",
  {
    credentialTypeName: z.string().describe("The credential type name (e.g. 'githubApi', 'googleSheetsOAuth2Api')"),
  },
  async ({ credentialTypeName }) => {
    const data = await n8nRequest("GET", `/credentials/schema/${credentialTypeName}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create-credential",
  "Create a new credential. Use get-credential-schema first to know what data fields are required.",
  {
    name: z.string().describe("Display name for the credential"),
    type: z.string().describe("Credential type name (e.g. 'githubApi', 'slackApi')"),
    data: z.record(z.unknown()).describe("Credential data fields (varies by type — use get-credential-schema to see required fields)"),
  },
  async ({ name, type, data }) => {
    const result = await n8nRequest("POST", "/credentials", { name, type, data });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "update-credential",
  "Update an existing credential by ID.",
  {
    id: z.string().describe("Credential ID"),
    name: z.string().optional().describe("New display name"),
    data: z.record(z.unknown()).optional().describe("Updated credential data fields"),
  },
  async ({ id, name, data }) => {
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (data !== undefined) body.data = data;
    const result = await n8nRequest("PATCH", `/credentials/${id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "delete-credential",
  "Permanently delete a credential by ID.",
  {
    id: z.string().describe("Credential ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("DELETE", `/credentials/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// VARIABLES (Global)
// ════════════════════════════════════════════════════════════════════

server.tool(
  "list-variables",
  "List all global variables defined in n8n.",
  {
    limit: z.number().int().min(1).max(250).default(100).describe("Max number of results"),
    cursor: z.string().optional().describe("Pagination cursor"),
  },
  async ({ limit, cursor }) => {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const data = await n8nRequest("GET", `/variables?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create-variable",
  "Create a new global variable.",
  {
    key: z.string().describe("Variable key/name"),
    value: z.string().describe("Variable value"),
    type: z.enum(["string", "number", "boolean", "secret"]).optional().default("string").describe("Variable type"),
  },
  async ({ key, value, type }) => {
    const data = await n8nRequest("POST", "/variables", { key, value, type });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update-variable",
  "Update an existing global variable.",
  {
    id: z.string().describe("Variable ID"),
    key: z.string().optional().describe("New key/name"),
    value: z.string().optional().describe("New value"),
    type: z.enum(["string", "number", "boolean", "secret"]).optional().describe("New type"),
  },
  async ({ id, key, value, type }) => {
    const body: Record<string, unknown> = {};
    if (key !== undefined) body.key = key;
    if (value !== undefined) body.value = value;
    if (type !== undefined) body.type = type;
    const data = await n8nRequest("PATCH", `/variables/${id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "delete-variable",
  "Delete a global variable by ID.",
  {
    id: z.string().describe("Variable ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("DELETE", `/variables/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// TAGS
// ════════════════════════════════════════════════════════════════════

server.tool(
  "list-tags",
  "List all tags in n8n.",
  {
    limit: z.number().int().min(1).max(250).default(100).describe("Max number of results"),
    cursor: z.string().optional().describe("Pagination cursor"),
    withUsageCount: z.boolean().optional().default(false).describe("Include count of workflows using each tag"),
  },
  async ({ limit, cursor, withUsageCount }) => {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    if (withUsageCount) params.set("withUsageCount", "true");
    const data = await n8nRequest("GET", `/tags?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get-tag",
  "Get a specific tag by ID.",
  {
    id: z.string().describe("Tag ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("GET", `/tags/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create-tag",
  "Create a new tag.",
  {
    name: z.string().describe("Tag name"),
  },
  async ({ name }) => {
    const data = await n8nRequest("POST", "/tags", { name });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update-tag",
  "Update an existing tag.",
  {
    id: z.string().describe("Tag ID"),
    name: z.string().describe("New tag name"),
  },
  async ({ id, name }) => {
    const data = await n8nRequest("PUT", `/tags/${id}`, { name });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "delete-tag",
  "Delete a tag by ID.",
  {
    id: z.string().describe("Tag ID"),
  },
  async ({ id }) => {
    const data = await n8nRequest("DELETE", `/tags/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════════════

server.tool(
  "list-users",
  "List all users in the n8n instance.",
  {
    limit: z.number().int().min(1).max(250).default(100).describe("Max number of results"),
    cursor: z.string().optional().describe("Pagination cursor"),
    includeRole: z.boolean().optional().default(true).describe("Include user role in response"),
  },
  async ({ limit, cursor, includeRole }) => {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    if (includeRole) params.set("includeRole", "true");
    const data = await n8nRequest("GET", `/users?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get-user",
  "Get a specific user by ID or email.",
  {
    idOrEmail: z.string().describe("User ID or email address"),
    includeRole: z.boolean().optional().default(true).describe("Include user role in response"),
  },
  async ({ idOrEmail, includeRole }) => {
    const data = await n8nRequest("GET", `/users/${encodeURIComponent(idOrEmail)}?includeRole=${includeRole}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// SOURCE CONTROL
// ════════════════════════════════════════════════════════════════════

server.tool(
  "source-control-pull",
  "Pull the latest changes from the connected Git repository (requires Source Control feature).",
  {
    force: z.boolean().optional().default(false).describe("Force pull even if there are local changes"),
  },
  async ({ force }) => {
    const data = await n8nRequest("POST", "/source-control/pull", { force });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "source-control-push",
  "Push local changes to the connected Git repository (requires Source Control feature).",
  {
    message: z.string().optional().default("Changes pushed via MCP").describe("Commit message"),
    force: z.boolean().optional().default(false).describe("Force push"),
  },
  async ({ message, force }) => {
    const data = await n8nRequest("POST", "/source-control/push", { message, force });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// AUDIT
// ════════════════════════════════════════════════════════════════════

server.tool(
  "generate-audit",
  "Generate a security audit report for the n8n instance.",
  {
    categories: z.array(z.enum(["credentials", "database", "nodes", "filesystem", "instance"])).optional().describe("Audit categories to include (defaults to all)"),
    daysAbandonedWorkflow: z.number().int().optional().default(90).describe("Days threshold to consider a workflow abandoned"),
  },
  async ({ categories, daysAbandonedWorkflow }) => {
    const body: Record<string, unknown> = { additionalOptions: { daysAbandonedWorkflow } };
    if (categories) body.categories = categories;
    const data = await n8nRequest("POST", "/audit", body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// COMMUNITY NODES
// ════════════════════════════════════════════════════════════════════

server.tool(
  "list-community-nodes",
  "List all installed community nodes.",
  {},
  async () => {
    const data = await n8nRequest("GET", "/community-nodes");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "install-community-node",
  "Install a community node package from npm.",
  {
    name: z.string().describe("npm package name (e.g. 'n8n-nodes-mcp')"),
  },
  async ({ name }) => {
    const data = await n8nRequest("POST", "/community-nodes", { name });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update-community-node",
  "Update an installed community node to the latest version.",
  {
    name: z.string().describe("npm package name of the community node"),
  },
  async ({ name }) => {
    const data = await n8nRequest("PATCH", `/community-nodes/${encodeURIComponent(name)}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "uninstall-community-node",
  "Uninstall a community node package.",
  {
    name: z.string().describe("npm package name of the community node"),
  },
  async ({ name }) => {
    const data = await n8nRequest("DELETE", `/community-nodes/${encodeURIComponent(name)}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// SERVER HEALTH & INFO
// ════════════════════════════════════════════════════════════════════

server.tool(
  "get-n8n-info",
  "Get n8n instance health, version, and basic status information.",
  {},
  async () => {
    const [health, version] = await Promise.allSettled([
      n8nRequest("GET", "/health" as string),
      fetch(`${N8N_BASE_URL}/api/v1/health`).then((r) => r.json()),
    ]);
    const data = {
      health: health.status === "fulfilled" ? health.value : null,
      version: version.status === "fulfilled" ? version.value : null,
    };
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// TRANSPORT
// ════════════════════════════════════════════════════════════════════

async function startServer() {
  if (MCP_TRANSPORT === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("n8n MCP server running on stdio");
    return;
  }

  // SSE / HTTP mode
  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || "/", `http://localhost:${MCP_PORT}`);
    const pathname = urlObj.pathname;

    // ── CORS ──────────────────────────────────────────────────────────
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── OAuth metadata ────────────────────────────────────────────────
    if (pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      const base = OAUTH_BASE_URL || `http://localhost:${MCP_PORT}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256", "plain"],
      }));
      return;
    }

    // ── OAuth authorize ───────────────────────────────────────────────
    if (pathname === "/oauth/authorize" && req.method === "GET") {
      if (!OAUTH_USER_EMAIL || !OAUTH_USER_PASSWORD) {
        res.writeHead(302, { Location: `${urlObj.searchParams.get("redirect_uri")}?error=oauth_not_configured` });
        res.end();
        return;
      }
      const loginHtml = `<!DOCTYPE html><html><head><title>n8n MCP Login</title>
        <style>body{font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px}
        input{width:100%;padding:8px;margin:8px 0;box-sizing:border-box}
        button{width:100%;padding:10px;background:#ff6d5a;color:#fff;border:none;cursor:pointer;font-size:16px}</style></head>
        <body><h2>n8n MCP Server</h2>
        <form method="POST" action="/oauth/authorize">
          <input type="hidden" name="client_id" value="${urlObj.searchParams.get("client_id") || ""}">
          <input type="hidden" name="redirect_uri" value="${urlObj.searchParams.get("redirect_uri") || ""}">
          <input type="hidden" name="state" value="${urlObj.searchParams.get("state") || ""}">
          <input type="hidden" name="code_challenge" value="${urlObj.searchParams.get("code_challenge") || ""}">
          <input type="hidden" name="code_challenge_method" value="${urlObj.searchParams.get("code_challenge_method") || ""}">
          <input type="email" name="email" placeholder="Email" required>
          <input type="password" name="password" placeholder="Password" required>
          <button type="submit">Login</button>
        </form></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(loginHtml);
      return;
    }

    // ── OAuth authorize POST ──────────────────────────────────────────
    if (pathname === "/oauth/authorize" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "unknown";
      if (!checkLoginRateLimit(ip)) {
        res.writeHead(429, { "Content-Type": "text/plain" });
        res.end("Too many login attempts. Please try again later.");
        return;
      }
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });
      const params = new URLSearchParams(body);
      const email = params.get("email") || "";
      const password = params.get("password") || "";
      const clientId = params.get("client_id") || "";
      const redirectUri = params.get("redirect_uri") || "";
      const state = params.get("state") || "";
      const codeChallenge = params.get("code_challenge") || undefined;
      const codeChallengeMethod = params.get("code_challenge_method") || undefined;

      if (email !== OAUTH_USER_EMAIL || password !== OAUTH_USER_PASSWORD) {
        res.writeHead(302, { Location: `/oauth/authorize?error=invalid_credentials&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}` });
        res.end();
        return;
      }
      const code = crypto.randomBytes(32).toString("hex");
      authCodes.set(code, { clientId, redirectUri, codeChallenge, codeChallengeMethod, expiresAt: Date.now() + 10 * 60 * 1000 });
      const sep = redirectUri.includes("?") ? "&" : "?";
      res.writeHead(302, { Location: `${redirectUri}${sep}code=${code}&state=${encodeURIComponent(state)}` });
      res.end();
      return;
    }

    // ── OAuth token ───────────────────────────────────────────────────
    if (pathname === "/oauth/token" && req.method === "POST") {
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });
      let params: URLSearchParams | Record<string, string>;
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) {
        params = JSON.parse(body) as Record<string, string>;
      } else {
        params = new URLSearchParams(body);
      }
      const get = (k: string) => (params instanceof URLSearchParams ? params.get(k) : params[k]) || "";

      const grantType = get("grant_type");

      if (grantType === "authorization_code") {
        const code = get("code");
        const storedCode = authCodes.get(code);
        if (!storedCode || storedCode.expiresAt < Date.now()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        authCodes.delete(code);
        const accessToken = generateAccessToken(storedCode.clientId);
        const refreshToken = generateRefreshToken(storedCode.clientId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: OAUTH_TOKEN_EXPIRY }));
        return;
      }

      if (grantType === "refresh_token") {
        const token = get("refresh_token");
        const stored = refreshTokens.get(token);
        if (!stored || stored.expiresAt < Date.now()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        refreshTokens.delete(token);
        const accessToken = generateAccessToken(stored.clientId);
        const newRefresh = generateRefreshToken(stored.clientId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: accessToken, refresh_token: newRefresh, token_type: "Bearer", expires_in: OAUTH_TOKEN_EXPIRY }));
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }

    // ── Health check ──────────────────────────────────────────────────
    if (pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "n8n-mcp-server" }));
      return;
    }

    // ── SSE endpoint ──────────────────────────────────────────────────
    if (pathname === "/sse" && req.method === "GET") {
      const auth = verifyRequestAuthentication(req);
      if (!auth.ok) {
        res.writeHead(auth.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: auth.message }));
        return;
      }
      const transport = new SSEServerTransport("/messages", res);
      sseTransports.set(transport.sessionId, transport);
      res.on("close", () => sseTransports.delete(transport.sessionId));
      await server.connect(transport);
      return;
    }

    // ── Messages endpoint ─────────────────────────────────────────────
    if (pathname === "/messages" && req.method === "POST") {
      const auth = verifyRequestAuthentication(req);
      if (!auth.ok) {
        res.writeHead(auth.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: auth.message }));
        return;
      }
      const sessionId = urlObj.searchParams.get("sessionId") || req.headers["mcp-session-id"] as string;
      const transport = sseTransports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(MCP_PORT, () => {
    console.error(`n8n MCP server running on port ${MCP_PORT} (SSE)`);
    console.error(`SSE endpoint: http://localhost:${MCP_PORT}/sse`);
    if (OAUTH_USER_EMAIL) {
      console.error(`OAuth enabled — authorize at http://localhost:${MCP_PORT}/oauth/authorize`);
    }
  });
}

startServer().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
