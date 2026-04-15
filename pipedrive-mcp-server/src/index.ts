import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as pipedrive from "pipedrive";
import * as dotenv from 'dotenv';
import Bottleneck from 'bottleneck';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import http from 'http';
import { URL, URLSearchParams } from 'url';

// Type for error handling
interface ErrorWithMessage {
  message: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

// Load environment variables
dotenv.config();

// Check for required environment variables
if (!process.env.PIPEDRIVE_API_TOKEN) {
  console.error("ERROR: PIPEDRIVE_API_TOKEN environment variable is required");
  process.exit(1);
}

if (!process.env.PIPEDRIVE_DOMAIN) {
  console.error("ERROR: PIPEDRIVE_DOMAIN environment variable is required (e.g., 'ukkofi.pipedrive.com')");
  process.exit(1);
}

// OAuth 2.0 Configuration
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'pipedrive-mcp-client';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || crypto.randomBytes(32).toString('hex');
const OAUTH_USER_EMAIL = process.env.OAUTH_USER_EMAIL || '';
const OAUTH_USER_PASSWORD = process.env.OAUTH_USER_PASSWORD || '';
const OAUTH_JWT_SECRET = process.env.OAUTH_JWT_SECRET || crypto.randomBytes(64).toString('hex');
const OAUTH_TOKEN_EXPIRY = 3600; // 1 hour
const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || '';

// In-memory stores for OAuth
const authCodes = new Map<string, { clientId: string; redirectUri: string; codeChallenge?: string; codeChallengeMethod?: string; expiresAt: number }>();
const refreshTokens = new Map<string, { clientId: string; expiresAt: number }>();

// Rate limiting for login attempts
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (!attempt || (now - attempt.lastAttempt) > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now });
    return true;
  }
  if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
    return false;
  }
  attempt.count++;
  attempt.lastAttempt = now;
  return true;
}

function generateAccessToken(clientId: string): string {
  return jwt.sign({ client_id: clientId, type: 'access' }, OAUTH_JWT_SECRET, { expiresIn: OAUTH_TOKEN_EXPIRY });
}

function generateRefreshToken(clientId: string): string {
  const token = crypto.randomBytes(48).toString('hex');
  refreshTokens.set(token, { clientId, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }); // 30 days
  return token;
}

const verifyRequestAuthentication = (req: http.IncomingMessage) => {
  // If OAuth is not configured, allow all requests
  if (!OAUTH_USER_EMAIL || !OAUTH_USER_PASSWORD) {
    return { ok: true } as const;
  }

  const header = req.headers['authorization'];
  if (!header) {
    return { ok: false, status: 401, message: 'Missing Authorization header' } as const;
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return { ok: false, status: 401, message: 'Invalid Authorization header format' } as const;
  }

  try {
    jwt.verify(token, OAUTH_JWT_SECRET);
    return { ok: true } as const;
  } catch (error) {
    return { ok: false, status: 401, message: 'Invalid or expired token' } as const;
  }
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getClientIp(req: http.IncomingMessage): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function renderLoginPage(clientId: string, redirectUri: string, state: string, codeChallenge: string, codeChallengeMethod: string, error?: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pipedrive MCP - Login</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .card{background:#16213e;border-radius:12px;padding:2rem;max-width:400px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,.3)}
  h1{color:#e94560;margin:0 0 .5rem;font-size:1.5rem}
  p{color:#999;margin:0 0 1.5rem;font-size:.9rem}
  label{display:block;margin-bottom:.5rem;font-size:.85rem;color:#aaa}
  input{width:100%;padding:.75rem;border:1px solid #333;border-radius:8px;background:#0f3460;color:#fff;font-size:1rem;box-sizing:border-box;margin-bottom:1rem}
  input:focus{outline:none;border-color:#e94560}
  button{width:100%;padding:.75rem;background:#e94560;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer;font-weight:600}
  button:hover{background:#c73e54}
  .error{background:#5c1a1a;border:1px solid #e94560;border-radius:8px;padding:.75rem;margin-bottom:1rem;font-size:.85rem}
</style></head><body>
<div class="card">
  <h1>Pipedrive MCP</h1>
  <p>Sign in to authorize access to your Pipedrive data</p>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="code_challenge" value="${codeChallenge}">
    <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
    <label>Email</label>
    <input type="email" name="email" required autofocus>
    <label>Password</label>
    <input type="password" name="password" required>
    <button type="submit">Sign In</button>
  </form>
</div></body></html>`;
}

const limiter = new Bottleneck({
  minTime: Number(process.env.PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS || 250),
  maxConcurrent: Number(process.env.PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT || 2),
});

const withRateLimit = <T extends object>(client: T): T => {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (...args: unknown[]) => limiter.schedule(() => (value as Function).apply(target, args));
      }
      return value;
    },
  });
};

// Initialize Pipedrive API client with API token and custom domain
const apiClient = new pipedrive.ApiClient();
apiClient.basePath = `https://${process.env.PIPEDRIVE_DOMAIN}/api/v1`;
apiClient.authentications = apiClient.authentications || {};
apiClient.authentications['api_key'] = {
  type: 'apiKey',
  'in': 'query',
  name: 'api_token',
  apiKey: process.env.PIPEDRIVE_API_TOKEN
};

// Initialize Pipedrive API clients
const dealsApi = withRateLimit(new pipedrive.DealsApi(apiClient));
const personsApi = withRateLimit(new pipedrive.PersonsApi(apiClient));
const organizationsApi = withRateLimit(new pipedrive.OrganizationsApi(apiClient));
const pipelinesApi = withRateLimit(new pipedrive.PipelinesApi(apiClient));
const itemSearchApi = withRateLimit(new pipedrive.ItemSearchApi(apiClient));
const leadsApi = withRateLimit(new pipedrive.LeadsApi(apiClient));
// @ts-ignore - ActivitiesApi exists but may not be in type definitions
const activitiesApi = withRateLimit(new pipedrive.ActivitiesApi(apiClient));
// @ts-ignore - NotesApi exists but may not be in type definitions
const notesApi = withRateLimit(new pipedrive.NotesApi(apiClient));
// @ts-ignore - UsersApi exists but may not be in type definitions
const usersApi = withRateLimit(new pipedrive.UsersApi(apiClient));
// @ts-ignore
const stagesApi = withRateLimit(new pipedrive.StagesApi(apiClient));
// @ts-ignore
const productsApi = withRateLimit(new pipedrive.ProductsApi(apiClient));
// @ts-ignore
const filesApi = withRateLimit(new pipedrive.FilesApi(apiClient));
// @ts-ignore
const filtersApi = withRateLimit(new pipedrive.FiltersApi(apiClient));
// @ts-ignore
const goalsApi = withRateLimit(new pipedrive.GoalsApi(apiClient));
// @ts-ignore
const rolesApi = withRateLimit(new pipedrive.RolesApi(apiClient));
// @ts-ignore
const projectsApi = withRateLimit(new pipedrive.ProjectsApi(apiClient));
// @ts-ignore
const tasksApi = withRateLimit(new pipedrive.TasksApi(apiClient));
// @ts-ignore
const webhooksApi = withRateLimit(new pipedrive.WebhooksApi(apiClient));
// @ts-ignore
const currenciesApi = withRateLimit(new pipedrive.CurrenciesApi(apiClient));
// @ts-ignore
const callLogsApi = withRateLimit(new pipedrive.CallLogsApi(apiClient));
// @ts-ignore
const activityTypesApi = withRateLimit(new pipedrive.ActivityTypesApi(apiClient));
// @ts-ignore
const activityFieldsApi = withRateLimit(new pipedrive.ActivityFieldsApi(apiClient));
// @ts-ignore
const dealFieldsApi = withRateLimit(new pipedrive.DealFieldsApi(apiClient));
// @ts-ignore
const personFieldsApi = withRateLimit(new pipedrive.PersonFieldsApi(apiClient));
// @ts-ignore
const organizationFieldsApi = withRateLimit(new pipedrive.OrganizationFieldsApi(apiClient));
// @ts-ignore
const productFieldsApi = withRateLimit(new pipedrive.ProductFieldsApi(apiClient));
// @ts-ignore
const noteFieldsApi = withRateLimit(new pipedrive.NoteFieldsApi(apiClient));
// @ts-ignore
const leadLabelsApi = withRateLimit(new pipedrive.LeadLabelsApi(apiClient));
// @ts-ignore
const leadSourcesApi = withRateLimit(new pipedrive.LeadSourcesApi(apiClient));
// @ts-ignore
const organizationRelationshipsApi = withRateLimit(new pipedrive.OrganizationRelationshipsApi(apiClient));
// @ts-ignore
const permissionSetsApi = withRateLimit(new pipedrive.PermissionSetsApi(apiClient));
// @ts-ignore
const recentsApi = withRateLimit(new pipedrive.RecentsApi(apiClient));
// @ts-ignore
const userSettingsApi = withRateLimit(new pipedrive.UserSettingsApi(apiClient));
// @ts-ignore
const mailboxApi = withRateLimit(new pipedrive.MailboxApi(apiClient));

// Create MCP server
const server = new McpServer({
  name: "pipedrive-mcp-server",
  version: "1.0.2",
  capabilities: {
    resources: {},
    tools: {},
    prompts: {}
  }
});

// === TOOLS ===

// Get all users (for finding owner IDs)
server.tool(
  "get-users",
  "Get all users/owners from Pipedrive to identify owner IDs for filtering deals",
  {},
  async () => {
    try {
      const response = await usersApi.getUsers();
      const users = response.data?.map((user: any) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        active_flag: user.active_flag,
        role_name: user.role_name
      })) || [];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Found ${users.length} users in your Pipedrive account`,
            users: users
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching users:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching users: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deals with flexible filtering options
server.tool(
  "get-deals",
  "Get deals from Pipedrive with flexible filtering options including search by title, date range, owner, stage, status, and more. Use 'get-users' tool first to find owner IDs.",
  {
    searchTitle: z.string().optional().describe("Search deals by title/name (partial matches supported)"),
    daysBack: z.number().optional().describe("Number of days back to fetch deals based on last activity date (default: 365)"),
    ownerId: z.number().optional().describe("Filter deals by owner/user ID (use get-users tool to find IDs)"),
    stageId: z.number().optional().describe("Filter deals by stage ID"),
    status: z.enum(['open', 'won', 'lost', 'deleted']).optional().describe("Filter deals by status (default: open)"),
    pipelineId: z.number().optional().describe("Filter deals by pipeline ID"),
    minValue: z.number().optional().describe("Minimum deal value filter"),
    maxValue: z.number().optional().describe("Maximum deal value filter"),
    limit: z.number().optional().describe("Maximum number of deals to return (default: 500)")
  },
  async ({
    searchTitle,
    daysBack = 365,
    ownerId,
    stageId,
    status = 'open',
    pipelineId,
    minValue,
    maxValue,
    limit = 500
  }) => {
    try {
      let filteredDeals: any[] = [];

      // If searching by title, use the search API first
      if (searchTitle) {
        // @ts-ignore - Bypass incorrect TypeScript definition
        const searchResponse = await dealsApi.searchDeals(searchTitle);
        filteredDeals = searchResponse.data || [];
      } else {
        // Calculate the date filter (daysBack days ago)
        const filterDate = new Date();
        filterDate.setDate(filterDate.getDate() - daysBack);
        const startDate = filterDate.toISOString().split('T')[0]; // Format as YYYY-MM-DD

        // Build API parameters (using actual Pipedrive API parameter names)
        const params: any = {
          sort: 'last_activity_date DESC',
          status: status,
          limit: limit
        };

        // Add optional filters
        if (ownerId) params.user_id = ownerId;
        if (stageId) params.stage_id = stageId;
        if (pipelineId) params.pipeline_id = pipelineId;

        // Fetch deals with filters
        // @ts-ignore - getDeals accepts parameters but types may be incomplete
        const response = await dealsApi.getDeals(params);
        filteredDeals = response.data || [];
      }

      // Apply additional client-side filtering

      // Filter by date if not searching by title
      if (!searchTitle) {
        const filterDate = new Date();
        filterDate.setDate(filterDate.getDate() - daysBack);

        filteredDeals = filteredDeals.filter((deal: any) => {
          if (!deal.last_activity_date) return false;
          const dealActivityDate = new Date(deal.last_activity_date);
          return dealActivityDate >= filterDate;
        });
      }

      // Filter by owner if specified and not already applied in API call
      if (ownerId && searchTitle) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.owner_id === ownerId);
      }

      // Filter by status if specified and searching by title
      if (status && searchTitle) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.status === status);
      }

      // Filter by stage if specified and not already applied in API call
      if (stageId && (searchTitle || !stageId)) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.stage_id === stageId);
      }

      // Filter by pipeline if specified and not already applied in API call
      if (pipelineId && (searchTitle || !pipelineId)) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.pipeline_id === pipelineId);
      }

      // Filter by value range if specified
      if (minValue !== undefined || maxValue !== undefined) {
        filteredDeals = filteredDeals.filter((deal: any) => {
          const value = parseFloat(deal.value) || 0;
          if (minValue !== undefined && value < minValue) return false;
          if (maxValue !== undefined && value > maxValue) return false;
          return true;
        });
      }

      // Apply limit
      if (filteredDeals.length > limit) {
        filteredDeals = filteredDeals.slice(0, limit);
      }

      // Build filter summary for response
      const filterSummary = {
        ...(searchTitle && { search_title: searchTitle }),
        ...(!searchTitle && { days_back: daysBack }),
        ...(!searchTitle && { filter_date: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0] }),
        status: status,
        ...(ownerId && { owner_id: ownerId }),
        ...(stageId && { stage_id: stageId }),
        ...(pipelineId && { pipeline_id: pipelineId }),
        ...(minValue !== undefined && { min_value: minValue }),
        ...(maxValue !== undefined && { max_value: maxValue }),
        total_deals_found: filteredDeals.length,
        limit_applied: limit
      };

      // Summarize deals to avoid massive responses but include notes and booking details
      const bookingFieldKey = "8f4b27fbd9dfc70d2296f23ce76987051ad7324e";
      const summarizedDeals = filteredDeals.map((deal: any) => ({
        id: deal.id,
        title: deal.title,
        value: deal.value,
        currency: deal.currency,
        status: deal.status,
        stage_name: deal.stage?.name || 'Unknown',
        pipeline_name: deal.pipeline?.name || 'Unknown',
        owner_name: deal.owner?.name || 'Unknown',
        organization_name: deal.org?.name || null,
        person_name: deal.person?.name || null,
        add_time: deal.add_time,
        last_activity_date: deal.last_activity_date,
        close_time: deal.close_time,
        won_time: deal.won_time,
        lost_time: deal.lost_time,
        notes_count: deal.notes_count || 0,
        // Include recent notes if available
        notes: deal.notes || [],
        // Include custom booking details field
        booking_details: deal[bookingFieldKey] || null
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: searchTitle
              ? `Found ${filteredDeals.length} deals matching title search "${searchTitle}"`
              : `Found ${filteredDeals.length} deals matching the specified filters`,
            filters_applied: filterSummary,
            total_found: filteredDeals.length,
            deals: summarizedDeals.slice(0, 30) // Limit to 30 deals max to prevent huge responses
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching deals:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deals: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deal by ID
server.tool(
  "get-deal",
  "Get a specific deal by ID including custom fields",
  {
    dealId: z.number().describe("Pipedrive deal ID")
  },
  async ({ dealId }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition, API expects just the ID
      const response = await dealsApi.getDeal(dealId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching deal ${dealId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deal ${dealId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deal notes and custom booking details
server.tool(
  "get-deal-notes",
  "Get detailed notes and custom booking details for a specific deal",
  {
    dealId: z.number().describe("Pipedrive deal ID"),
    limit: z.number().optional().describe("Maximum number of notes to return (default: 20)")
  },
  async ({ dealId, limit = 20 }) => {
    try {
      const result: any = {
        deal_id: dealId,
        notes: [],
        booking_details: null
      };

      // Get deal details including custom fields
      try {
        // @ts-ignore - Bypass incorrect TypeScript definition
        const dealResponse = await dealsApi.getDeal(dealId);
        const deal = dealResponse.data;

        // Extract custom booking field
        const bookingFieldKey = "8f4b27fbd9dfc70d2296f23ce76987051ad7324e";
        if (deal && deal[bookingFieldKey]) {
          result.booking_details = deal[bookingFieldKey];
        }
      } catch (dealError) {
        console.error(`Error fetching deal details for ${dealId}:`, dealError);
        result.deal_error = getErrorMessage(dealError);
      }

      // Get deal notes
      try {
        // @ts-ignore - API parameters may not be fully typed
        // @ts-ignore - Bypass incorrect TypeScript definition
        const notesResponse = await notesApi.getNotes({
          deal_id: dealId,
          limit: limit
        });
        result.notes = notesResponse.data || [];
      } catch (noteError) {
        console.error(`Error fetching notes for deal ${dealId}:`, noteError);
        result.notes_error = getErrorMessage(noteError);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Retrieved ${result.notes.length} notes and booking details for deal ${dealId}`,
            ...result
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching deal notes ${dealId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deal notes ${dealId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search deals
server.tool(
  "search-deals",
  "Search deals by term",
  {
    term: z.string().describe("Search term for deals")
  },
  async ({ term }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await dealsApi.searchDeals(term);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching deals with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching deals: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all persons
server.tool(
  "get-persons",
  "Get all persons from Pipedrive including custom fields",
  {},
  async () => {
    try {
      const response = await personsApi.getPersons();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching persons:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching persons: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get person by ID
server.tool(
  "get-person",
  "Get a specific person by ID including custom fields",
  {
    personId: z.number().describe("Pipedrive person ID")
  },
  async ({ personId }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await personsApi.getPerson(personId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching person ${personId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching person ${personId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search persons
server.tool(
  "search-persons",
  "Search persons by term",
  {
    term: z.string().describe("Search term for persons")
  },
  async ({ term }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await personsApi.searchPersons(term);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching persons with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching persons: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all organizations
server.tool(
  "get-organizations",
  "Get all organizations from Pipedrive including custom fields",
  {},
  async () => {
    try {
      const response = await organizationsApi.getOrganizations();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching organizations:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching organizations: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get organization by ID
server.tool(
  "get-organization",
  "Get a specific organization by ID including custom fields",
  {
    organizationId: z.number().describe("Pipedrive organization ID")
  },
  async ({ organizationId }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await organizationsApi.getOrganization(organizationId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching organization ${organizationId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching organization ${organizationId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search organizations
server.tool(
  "search-organizations",
  "Search organizations by term",
  {
    term: z.string().describe("Search term for organizations")
  },
  async ({ term }) => {
    try {
      // @ts-ignore - API method exists but TypeScript definition is wrong
      const response = await (organizationsApi as any).searchOrganization({ term });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching organizations with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching organizations: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all pipelines
server.tool(
  "get-pipelines",
  "Get all pipelines from Pipedrive",
  {},
  async () => {
    try {
      const response = await pipelinesApi.getPipelines();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching pipelines:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pipelines: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get pipeline by ID
server.tool(
  "get-pipeline",
  "Get a specific pipeline by ID",
  {
    pipelineId: z.number().describe("Pipedrive pipeline ID")
  },
  async ({ pipelineId }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await pipelinesApi.getPipeline(pipelineId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching pipeline ${pipelineId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pipeline ${pipelineId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all stages
server.tool(
  "get-stages",
  "Get all stages from Pipedrive",
  {},
  async () => {
    try {
      // Since the stages are related to pipelines, we'll get all pipelines first
      const pipelinesResponse = await pipelinesApi.getPipelines();
      const pipelines = pipelinesResponse.data || [];
      
      // For each pipeline, fetch its stages
      const allStages = [];
      for (const pipeline of pipelines) {
        try {
          // @ts-ignore - Type definitions for getPipelineStages are incomplete
          const stagesResponse = await pipelinesApi.getPipelineStages(pipeline.id);
          const stagesData = Array.isArray(stagesResponse?.data)
            ? stagesResponse.data
            : [];

          if (stagesData.length > 0) {
            const pipelineStages = stagesData.map((stage: any) => ({
              ...stage,
              pipeline_name: pipeline.name
            }));
            allStages.push(...pipelineStages);
          }
        } catch (e) {
          console.error(`Error fetching stages for pipeline ${pipeline.id}:`, e);
        }
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(allStages, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching stages:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching stages: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search leads
server.tool(
  "search-leads",
  "Search leads by term",
  {
    term: z.string().describe("Search term for leads")
  },
  async ({ term }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await leadsApi.searchLeads(term);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching leads with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching leads: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Generic search across item types
server.tool(
  "search-all",
  "Search across all item types (deals, persons, organizations, etc.)",
  {
    term: z.string().describe("Search term"),
    itemTypes: z.string().optional().describe("Comma-separated list of item types to search (deal,person,organization,product,file,activity,lead)")
  },
  async ({ term, itemTypes }) => {
    try {
      const itemType = itemTypes; // Just rename the parameter
      const response = await itemSearchApi.searchItem({ 
        term,
        itemType 
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error performing search with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error performing search: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// --- USERS (additional) ---

server.tool(
  "get-user",
  "Get a specific user by ID",
  { userId: z.number().describe("Pipedrive user ID") },
  async ({ userId }) => {
    try {
      // @ts-ignore
      const response = await usersApi.getUser(userId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-current-user",
  "Get the current authenticated user",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await usersApi.getCurrentUser();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-user-permissions",
  "Get user permissions",
  { userId: z.number().describe("Pipedrive user ID") },
  async ({ userId }) => {
    try {
      // @ts-ignore
      const response = await usersApi.getUserPermissions(userId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-user-role-assignments",
  "Get user role assignments",
  { userId: z.number().describe("Pipedrive user ID") },
  async ({ userId }) => {
    try {
      // @ts-ignore
      const response = await usersApi.getUserRoleAssignments(userId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-user-role-settings",
  "Get user role settings",
  { userId: z.number().describe("Pipedrive user ID") },
  async ({ userId }) => {
    try {
      // @ts-ignore
      const response = await usersApi.getUserRoleSettings(userId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- ACTIVITIES ---

server.tool(
  "get-activities",
  "Get activities with optional filtering. To get activities for a specific deal use dealId. To get activities for a person use personId. To get activities for an org use orgId.",
  {
    dealId: z.number().optional().describe("Filter activities belonging to a specific deal ID"),
    personId: z.number().optional().describe("Filter activities belonging to a specific person ID"),
    orgId: z.number().optional().describe("Filter activities belonging to a specific organization ID"),
    userId: z.number().optional().describe("Filter by assigned user ID (omit or use with everyone=1 for all users)"),
    everyone: z.number().optional().describe("Set to 1 to return activities of all users (requires admin). Default returns only current user's activities."),
    type: z.string().optional().describe("Filter by activity type key (e.g. call, meeting)"),
    done: z.number().optional().describe("Filter by done status: 0 = not done, 1 = done"),
    start: z.number().optional().describe("Pagination offset (default 0)"),
    limit: z.number().optional().describe("Max number of results to return (default 100, max 500)")
  },
  async (params) => {
    try {
      const opts: any = {};
      if (params.type !== undefined) opts.type = params.type;
      if (params.done !== undefined) opts.done = params.done;
      if (params.start !== undefined) opts.start = params.start;
      if (params.limit !== undefined) opts.limit = params.limit;

      let response: any;
      if (params.dealId !== undefined) {
        // @ts-ignore
        response = await dealsApi.getDealActivities(params.dealId, opts);
      } else if (params.personId !== undefined) {
        // @ts-ignore
        response = await personsApi.getPersonActivities(params.personId, opts);
      } else if (params.orgId !== undefined) {
        // @ts-ignore
        response = await organizationsApi.getOrganizationActivities(params.orgId, opts);
      } else {
        if (params.userId !== undefined) opts.user_id = params.userId;
        if (params.everyone === 1) opts.user_id = 0;
        // @ts-ignore
        response = await activitiesApi.getActivities(opts);
      }

      const activities = response.data || [];
      return { content: [{ type: "text", text: JSON.stringify(activities, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-activity",
  "Get a specific activity by ID",
  { activityId: z.number().describe("Activity ID") },
  async ({ activityId }) => {
    try {
      // @ts-ignore
      const response = await activitiesApi.getActivity(activityId);
      return { content: [{ type: "text", text: JSON.stringify(response.data || null, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-activity",
  "Add a new activity",
  {
    subject: z.string().describe("Activity subject"),
    type: z.string().describe("Activity type"),
    dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    dueTime: z.string().optional().describe("Due time (HH:MM)"),
    duration: z.string().optional().describe("Duration (HH:MM)"),
    dealId: z.number().optional().describe("Associated deal ID"),
    personId: z.number().optional().describe("Associated person ID"),
    orgId: z.number().optional().describe("Associated organization ID"),
    note: z.string().optional().describe("Activity note"),
    done: z.number().optional().describe("Done status (0 or 1)")
  },
  async (params) => {
    try {
      const body: any = { subject: params.subject, type: params.type };
      if (params.dueDate) body.due_date = params.dueDate;
      if (params.dueTime) body.due_time = params.dueTime;
      if (params.duration) body.duration = params.duration;
      if (params.dealId) body.deal_id = params.dealId;
      if (params.personId) body.person_id = params.personId;
      if (params.orgId) body.org_id = params.orgId;
      if (params.note) body.note = params.note;
      if (params.done !== undefined) body.done = params.done;
      // @ts-ignore
      const response = await activitiesApi.addActivity(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-activity",
  "Update an existing activity",
  {
    activityId: z.number().describe("Activity ID"),
    subject: z.string().optional().describe("Activity subject"),
    type: z.string().optional().describe("Activity type"),
    dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    done: z.number().optional().describe("Done status (0 or 1)")
  },
  async ({ activityId, ...params }) => {
    try {
      const body: any = {};
      if (params.subject) body.subject = params.subject;
      if (params.type) body.type = params.type;
      if (params.dueDate) body.due_date = params.dueDate;
      if (params.done !== undefined) body.done = params.done;
      // @ts-ignore
      const response = await activitiesApi.updateActivity(activityId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-activity",
  "Delete an activity",
  { activityId: z.number().describe("Activity ID") },
  async ({ activityId }) => {
    try {
      // @ts-ignore
      const response = await activitiesApi.deleteActivity(activityId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- ACTIVITY TYPES ---

server.tool(
  "get-activity-types",
  "Get all activity types",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await activityTypesApi.getActivityTypes();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-activity-type",
  "Add a new activity type",
  {
    name: z.string().describe("Activity type name"),
    iconKey: z.string().describe("Icon key for the activity type"),
    color: z.string().optional().describe("Color for the activity type")
  },
  async (params) => {
    try {
      const body: any = { name: params.name, icon_key: params.iconKey };
      if (params.color) body.color = params.color;
      // @ts-ignore
      const response = await activityTypesApi.addActivityType(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-activity-type",
  "Update an activity type",
  {
    activityTypeId: z.number().describe("Activity type ID"),
    name: z.string().optional().describe("Activity type name"),
    iconKey: z.string().optional().describe("Icon key"),
    color: z.string().optional().describe("Color")
  },
  async ({ activityTypeId, ...params }) => {
    try {
      const body: any = {};
      if (params.name) body.name = params.name;
      if (params.iconKey) body.icon_key = params.iconKey;
      if (params.color) body.color = params.color;
      // @ts-ignore
      const response = await activityTypesApi.updateActivityType(activityTypeId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-activity-type",
  "Delete an activity type",
  { activityTypeId: z.number().describe("Activity type ID") },
  async ({ activityTypeId }) => {
    try {
      // @ts-ignore
      const response = await activityTypesApi.deleteActivityType(activityTypeId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- DEALS (additional) ---

server.tool(
  "add-deal",
  "Add a new deal",
  {
    title: z.string().describe("Deal title"),
    value: z.string().optional().describe("Deal value"),
    currency: z.string().optional().describe("Deal currency"),
    userId: z.number().optional().describe("Owner user ID"),
    personId: z.number().optional().describe("Associated person ID"),
    orgId: z.number().optional().describe("Associated organization ID"),
    pipelineId: z.number().optional().describe("Pipeline ID"),
    stageId: z.number().optional().describe("Stage ID"),
    status: z.string().optional().describe("Deal status")
  },
  async (params) => {
    try {
      const body: any = { title: params.title };
      if (params.value) body.value = params.value;
      if (params.currency) body.currency = params.currency;
      if (params.userId) body.user_id = params.userId;
      if (params.personId) body.person_id = params.personId;
      if (params.orgId) body.org_id = params.orgId;
      if (params.pipelineId) body.pipeline_id = params.pipelineId;
      if (params.stageId) body.stage_id = params.stageId;
      if (params.status) body.status = params.status;
      // @ts-ignore
      const response = await dealsApi.addDeal(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-deal",
  "Update an existing deal",
  {
    dealId: z.number().describe("Deal ID"),
    title: z.string().optional().describe("Deal title"),
    value: z.string().optional().describe("Deal value"),
    status: z.string().optional().describe("Deal status"),
    stageId: z.number().optional().describe("Stage ID"),
    pipelineId: z.number().optional().describe("Pipeline ID")
  },
  async ({ dealId, ...params }) => {
    try {
      const body: any = {};
      if (params.title) body.title = params.title;
      if (params.value) body.value = params.value;
      if (params.status) body.status = params.status;
      if (params.stageId) body.stage_id = params.stageId;
      if (params.pipelineId) body.pipeline_id = params.pipelineId;
      // @ts-ignore
      const response = await dealsApi.updateDeal(dealId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-deal",
  "Delete a deal",
  { dealId: z.number().describe("Deal ID") },
  async ({ dealId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.deleteDeal(dealId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "duplicate-deal",
  "Duplicate a deal",
  { dealId: z.number().describe("Deal ID") },
  async ({ dealId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.duplicateDeal(dealId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-deal-files",
  "Get files attached to a deal",
  { dealId: z.number().describe("Deal ID") },
  async ({ dealId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.getDealFiles(dealId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-deal-flow",
  "Get deal updates/flow",
  { dealId: z.number().describe("Deal ID") },
  async ({ dealId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.getDealFlow(dealId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-deal-mail-messages",
  "Get mail messages associated with a deal",
  { dealId: z.number().describe("Deal ID") },
  async ({ dealId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.getDealMailMessages(dealId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-deal-participants",
  "Get participants of a deal",
  { dealId: z.number().describe("Deal ID") },
  async ({ dealId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.getDealParticipants(dealId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-deal-participant",
  "Add a participant to a deal",
  {
    dealId: z.number().describe("Deal ID"),
    personId: z.number().describe("Person ID to add as participant")
  },
  async ({ dealId, personId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.addDealParticipant(dealId, { person_id: personId });
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-deal-participant",
  "Remove a participant from a deal",
  {
    dealId: z.number().describe("Deal ID"),
    personId: z.number().describe("Person ID to remove")
  },
  async ({ dealId, personId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.deleteDealParticipant(dealId, personId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-deal-products",
  "Get products attached to a deal",
  { dealId: z.number().describe("Deal ID") },
  async ({ dealId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.getDealProducts(dealId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-deal-product",
  "Add a product to a deal",
  {
    dealId: z.number().describe("Deal ID"),
    productId: z.number().describe("Product ID"),
    itemPrice: z.number().describe("Price per item"),
    quantity: z.number().describe("Quantity")
  },
  async ({ dealId, productId, itemPrice, quantity }) => {
    try {
      const body: any = { product_id: productId, item_price: itemPrice, quantity: quantity };
      // @ts-ignore
      const response = await dealsApi.addDealProduct(dealId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-deals-summary",
  "Get a summary of all deals",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await dealsApi.getDealsSummary();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-deals-timeline",
  "Get deals timeline",
  {
    startDate: z.string().describe("Start date (YYYY-MM-DD)"),
    interval: z.string().describe("Interval: day, week, month, or quarter"),
    amount: z.number().describe("Number of intervals"),
    fieldKey: z.string().describe("Field key to use for timeline")
  },
  async (params) => {
    try {
      const body: any = {
        start_date: params.startDate,
        interval: params.interval,
        amount: params.amount,
        field_key: params.fieldKey
      };
      // @ts-ignore
      const response = await dealsApi.getDealsTimeline(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "merge-deals",
  "Merge two deals",
  {
    dealId: z.number().describe("Deal ID to keep"),
    mergeWithId: z.number().describe("Deal ID to merge into the first deal")
  },
  async ({ dealId, mergeWithId }) => {
    try {
      // @ts-ignore
      const response = await dealsApi.mergeDeals(dealId, { merge_with_id: mergeWithId });
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- PERSONS (additional) ---

server.tool(
  "add-person",
  "Add a new person",
  {
    name: z.string().describe("Person name"),
    email: z.string().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    orgId: z.number().optional().describe("Organization ID"),
    ownerId: z.number().optional().describe("Owner user ID")
  },
  async (params) => {
    try {
      const body: any = { name: params.name };
      if (params.email) body.email = params.email;
      if (params.phone) body.phone = params.phone;
      if (params.orgId) body.org_id = params.orgId;
      if (params.ownerId) body.owner_id = params.ownerId;
      // @ts-ignore
      const response = await personsApi.addPerson(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-person",
  "Update a person",
  {
    personId: z.number().describe("Person ID"),
    name: z.string().optional().describe("Person name"),
    email: z.string().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    orgId: z.number().optional().describe("Organization ID")
  },
  async ({ personId, ...params }) => {
    try {
      const body: any = {};
      if (params.name) body.name = params.name;
      if (params.email) body.email = params.email;
      if (params.phone) body.phone = params.phone;
      if (params.orgId) body.org_id = params.orgId;
      // @ts-ignore
      const response = await personsApi.updatePerson(personId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-person",
  "Delete a person",
  { personId: z.number().describe("Person ID") },
  async ({ personId }) => {
    try {
      // @ts-ignore
      const response = await personsApi.deletePerson(personId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "merge-persons",
  "Merge two persons",
  {
    personId: z.number().describe("Person ID to keep"),
    mergeWithId: z.number().describe("Person ID to merge into the first person")
  },
  async ({ personId, mergeWithId }) => {
    try {
      // @ts-ignore
      const response = await personsApi.mergePersons(personId, { merge_with_id: mergeWithId });
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-person-files",
  "Get files attached to a person",
  { personId: z.number().describe("Person ID") },
  async ({ personId }) => {
    try {
      // @ts-ignore
      const response = await personsApi.getPersonFiles(personId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-person-flow",
  "Get person updates/flow",
  { personId: z.number().describe("Person ID") },
  async ({ personId }) => {
    try {
      // @ts-ignore
      const response = await personsApi.getPersonUpdates(personId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-person-mail-messages",
  "Get mail messages associated with a person",
  { personId: z.number().describe("Person ID") },
  async ({ personId }) => {
    try {
      // @ts-ignore
      const response = await personsApi.getPersonMailMessages(personId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-person-products",
  "Get products associated with a person",
  { personId: z.number().describe("Person ID") },
  async ({ personId }) => {
    try {
      // @ts-ignore
      const response = await personsApi.getPersonProducts(personId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- ORGANIZATIONS (additional) ---

server.tool(
  "add-organization",
  "Add a new organization",
  {
    name: z.string().describe("Organization name"),
    ownerId: z.number().optional().describe("Owner user ID")
  },
  async (params) => {
    try {
      const body: any = { name: params.name };
      if (params.ownerId) body.owner_id = params.ownerId;
      // @ts-ignore
      const response = await organizationsApi.addOrganization(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-organization",
  "Update an organization",
  {
    organizationId: z.number().describe("Organization ID"),
    name: z.string().optional().describe("Organization name"),
    ownerId: z.number().optional().describe("Owner user ID")
  },
  async ({ organizationId, ...params }) => {
    try {
      const body: any = {};
      if (params.name) body.name = params.name;
      if (params.ownerId) body.owner_id = params.ownerId;
      // @ts-ignore
      const response = await organizationsApi.updateOrganization(organizationId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-organization",
  "Delete an organization",
  { organizationId: z.number().describe("Organization ID") },
  async ({ organizationId }) => {
    try {
      // @ts-ignore
      const response = await organizationsApi.deleteOrganization(organizationId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "merge-organizations",
  "Merge two organizations",
  {
    organizationId: z.number().describe("Organization ID to keep"),
    mergeWithId: z.number().describe("Organization ID to merge into the first")
  },
  async ({ organizationId, mergeWithId }) => {
    try {
      // @ts-ignore
      const response = await organizationsApi.mergeOrganizations(organizationId, { merge_with_id: mergeWithId });
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-organization-files",
  "Get files attached to an organization",
  { organizationId: z.number().describe("Organization ID") },
  async ({ organizationId }) => {
    try {
      // @ts-ignore
      const response = await organizationsApi.getOrganizationFiles(organizationId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-organization-flow",
  "Get organization updates/flow",
  { organizationId: z.number().describe("Organization ID") },
  async ({ organizationId }) => {
    try {
      // @ts-ignore
      const response = await organizationsApi.getOrganizationUpdates(organizationId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-organization-mail-messages",
  "Get mail messages associated with an organization",
  { organizationId: z.number().describe("Organization ID") },
  async ({ organizationId }) => {
    try {
      // @ts-ignore
      const response = await organizationsApi.getOrganizationMailMessages(organizationId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- LEADS (additional) ---

server.tool(
  "get-leads",
  "Get all leads",
  {
    limit: z.number().optional().describe("Max number of results"),
    start: z.number().optional().describe("Pagination start")
  },
  async (params) => {
    try {
      const opts: any = {};
      if (params.limit !== undefined) opts.limit = params.limit;
      if (params.start !== undefined) opts.start = params.start;
      // @ts-ignore
      const response = await leadsApi.getLeads(opts);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-lead",
  "Get a specific lead by ID",
  { leadId: z.string().describe("Lead ID") },
  async ({ leadId }) => {
    try {
      // @ts-ignore
      const response = await leadsApi.getLead(leadId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-lead",
  "Add a new lead",
  {
    title: z.string().describe("Lead title"),
    personId: z.number().optional().describe("Associated person ID"),
    organizationId: z.number().optional().describe("Associated organization ID"),
    value: z.object({ amount: z.number(), currency: z.string() }).optional().describe("Lead value with amount and currency"),
    expectedCloseDate: z.string().optional().describe("Expected close date (YYYY-MM-DD)")
  },
  async (params) => {
    try {
      const body: any = { title: params.title };
      if (params.personId) body.person_id = params.personId;
      if (params.organizationId) body.organization_id = params.organizationId;
      if (params.value) body.value = params.value;
      if (params.expectedCloseDate) body.expected_close_date = params.expectedCloseDate;
      // @ts-ignore
      const response = await leadsApi.addLead(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-lead",
  "Update a lead",
  {
    leadId: z.string().describe("Lead ID"),
    title: z.string().optional().describe("Lead title"),
    personId: z.number().optional().describe("Associated person ID"),
    organizationId: z.number().optional().describe("Associated organization ID")
  },
  async ({ leadId, ...params }) => {
    try {
      const body: any = {};
      if (params.title) body.title = params.title;
      if (params.personId) body.person_id = params.personId;
      if (params.organizationId) body.organization_id = params.organizationId;
      // @ts-ignore
      const response = await leadsApi.updateLead(leadId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-lead",
  "Delete a lead",
  { leadId: z.string().describe("Lead ID") },
  async ({ leadId }) => {
    try {
      // @ts-ignore
      const response = await leadsApi.deleteLead(leadId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- PRODUCTS ---

server.tool(
  "get-products",
  "Get all products",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await productsApi.getProducts();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-product",
  "Get a specific product by ID",
  { productId: z.number().describe("Product ID") },
  async ({ productId }) => {
    try {
      // @ts-ignore
      const response = await productsApi.getProduct(productId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "search-products",
  "Search products by term",
  { term: z.string().describe("Search term") },
  async ({ term }) => {
    try {
      // @ts-ignore
      const response = await productsApi.searchProducts(term);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-product",
  "Add a new product",
  {
    name: z.string().describe("Product name"),
    code: z.string().optional().describe("Product code"),
    unit: z.string().optional().describe("Product unit"),
    prices: z.array(z.any()).optional().describe("Product prices array")
  },
  async (params) => {
    try {
      const body: any = { name: params.name };
      if (params.code) body.code = params.code;
      if (params.unit) body.unit = params.unit;
      if (params.prices) body.prices = params.prices;
      // @ts-ignore
      const response = await productsApi.addProduct(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-product",
  "Update a product",
  {
    productId: z.number().describe("Product ID"),
    name: z.string().optional().describe("Product name"),
    code: z.string().optional().describe("Product code"),
    unit: z.string().optional().describe("Product unit")
  },
  async ({ productId, ...params }) => {
    try {
      const body: any = {};
      if (params.name) body.name = params.name;
      if (params.code) body.code = params.code;
      if (params.unit) body.unit = params.unit;
      // @ts-ignore
      const response = await productsApi.updateProduct(productId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-product",
  "Delete a product",
  { productId: z.number().describe("Product ID") },
  async ({ productId }) => {
    try {
      // @ts-ignore
      const response = await productsApi.deleteProduct(productId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-product-deals",
  "Get deals associated with a product",
  { productId: z.number().describe("Product ID") },
  async ({ productId }) => {
    try {
      // @ts-ignore
      const response = await productsApi.getProductDeals(productId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-product-files",
  "Get files attached to a product",
  { productId: z.number().describe("Product ID") },
  async ({ productId }) => {
    try {
      // @ts-ignore
      const response = await productsApi.getProductFiles(productId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- NOTES (additional) ---

server.tool(
  "get-notes",
  "Get all notes with optional filtering",
  {
    dealId: z.number().optional().describe("Filter by deal ID"),
    personId: z.number().optional().describe("Filter by person ID"),
    orgId: z.number().optional().describe("Filter by organization ID"),
    limit: z.number().optional().describe("Max number of results")
  },
  async (params) => {
    try {
      const opts: any = {};
      if (params.dealId !== undefined) opts.deal_id = params.dealId;
      if (params.personId !== undefined) opts.person_id = params.personId;
      if (params.orgId !== undefined) opts.org_id = params.orgId;
      if (params.limit !== undefined) opts.limit = params.limit;
      // @ts-ignore
      const response = await notesApi.getNotes(opts);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-note",
  "Get a specific note by ID",
  { noteId: z.number().describe("Note ID") },
  async ({ noteId }) => {
    try {
      // @ts-ignore
      const response = await notesApi.getNote(noteId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-note",
  "Add a new note",
  {
    content: z.string().describe("Note content"),
    dealId: z.number().optional().describe("Associated deal ID"),
    personId: z.number().optional().describe("Associated person ID"),
    orgId: z.number().optional().describe("Associated organization ID")
  },
  async (params) => {
    try {
      const body: any = { content: params.content };
      if (params.dealId) body.deal_id = params.dealId;
      if (params.personId) body.person_id = params.personId;
      if (params.orgId) body.org_id = params.orgId;
      // @ts-ignore
      const response = await notesApi.addNote(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-note",
  "Update a note",
  {
    noteId: z.number().describe("Note ID"),
    content: z.string().describe("Note content")
  },
  async ({ noteId, content }) => {
    try {
      // @ts-ignore
      const response = await notesApi.updateNote(noteId, { content });
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-note",
  "Delete a note",
  { noteId: z.number().describe("Note ID") },
  async ({ noteId }) => {
    try {
      // @ts-ignore
      const response = await notesApi.deleteNote(noteId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- PIPELINES (additional) ---

server.tool(
  "add-pipeline",
  "Add a new pipeline",
  {
    name: z.string().describe("Pipeline name"),
    dealProbability: z.number().optional().describe("Deal probability enabled (0 or 1)")
  },
  async (params) => {
    try {
      const body: any = { name: params.name };
      if (params.dealProbability !== undefined) body.deal_probability = params.dealProbability;
      // @ts-ignore
      const response = await pipelinesApi.addPipeline(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-pipeline",
  "Update a pipeline",
  {
    pipelineId: z.number().describe("Pipeline ID"),
    name: z.string().optional().describe("Pipeline name"),
    dealProbability: z.number().optional().describe("Deal probability enabled (0 or 1)")
  },
  async ({ pipelineId, ...params }) => {
    try {
      const body: any = {};
      if (params.name) body.name = params.name;
      if (params.dealProbability !== undefined) body.deal_probability = params.dealProbability;
      // @ts-ignore
      const response = await pipelinesApi.updatePipeline(pipelineId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-pipeline",
  "Delete a pipeline",
  { pipelineId: z.number().describe("Pipeline ID") },
  async ({ pipelineId }) => {
    try {
      // @ts-ignore
      const response = await pipelinesApi.deletePipeline(pipelineId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-pipeline-conversion-statistics",
  "Get pipeline conversion statistics",
  {
    pipelineId: z.number().describe("Pipeline ID"),
    startDate: z.string().describe("Start date (YYYY-MM-DD)"),
    endDate: z.string().describe("End date (YYYY-MM-DD)")
  },
  async ({ pipelineId, startDate, endDate }) => {
    try {
      // @ts-ignore
      const response = await pipelinesApi.getPipelineConversionStatistics(pipelineId, { start_date: startDate, end_date: endDate });
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-pipeline-movement-statistics",
  "Get pipeline movement statistics",
  {
    pipelineId: z.number().describe("Pipeline ID"),
    startDate: z.string().describe("Start date (YYYY-MM-DD)"),
    endDate: z.string().describe("End date (YYYY-MM-DD)")
  },
  async ({ pipelineId, startDate, endDate }) => {
    try {
      // @ts-ignore
      const response = await pipelinesApi.getPipelineMovementStatistics(pipelineId, { start_date: startDate, end_date: endDate });
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-pipeline-deals",
  "Get deals in a pipeline",
  { pipelineId: z.number().describe("Pipeline ID") },
  async ({ pipelineId }) => {
    try {
      // @ts-ignore
      const response = await pipelinesApi.getPipelineDeals(pipelineId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- STAGES (additional) ---

server.tool(
  "get-stage",
  "Get a specific stage by ID",
  { stageId: z.number().describe("Stage ID") },
  async ({ stageId }) => {
    try {
      // @ts-ignore
      const response = await stagesApi.getStage(stageId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-stage",
  "Add a new stage to a pipeline",
  {
    name: z.string().describe("Stage name"),
    pipelineId: z.number().describe("Pipeline ID"),
    dealProbability: z.number().optional().describe("Deal probability percentage")
  },
  async (params) => {
    try {
      const body: any = { name: params.name, pipeline_id: params.pipelineId };
      if (params.dealProbability !== undefined) body.deal_probability = params.dealProbability;
      // @ts-ignore
      const response = await stagesApi.addStage(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-stage",
  "Update a stage",
  {
    stageId: z.number().describe("Stage ID"),
    name: z.string().optional().describe("Stage name"),
    pipelineId: z.number().optional().describe("Pipeline ID")
  },
  async ({ stageId, ...params }) => {
    try {
      const body: any = {};
      if (params.name) body.name = params.name;
      if (params.pipelineId) body.pipeline_id = params.pipelineId;
      // @ts-ignore
      const response = await stagesApi.updateStage(stageId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-stage",
  "Delete a stage",
  { stageId: z.number().describe("Stage ID") },
  async ({ stageId }) => {
    try {
      // @ts-ignore
      const response = await stagesApi.deleteStage(stageId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-stage-deals",
  "Get deals in a stage",
  { stageId: z.number().describe("Stage ID") },
  async ({ stageId }) => {
    try {
      // @ts-ignore
      const response = await stagesApi.getStageDeals(stageId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- FILES ---

server.tool(
  "get-files",
  "Get all files",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await filesApi.getFiles();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-file",
  "Get a specific file by ID",
  { fileId: z.number().describe("File ID") },
  async ({ fileId }) => {
    try {
      // @ts-ignore
      const response = await filesApi.getFile(fileId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-file",
  "Delete a file",
  { fileId: z.number().describe("File ID") },
  async ({ fileId }) => {
    try {
      // @ts-ignore
      const response = await filesApi.deleteFile(fileId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- FILTERS ---

server.tool(
  "get-filters",
  "Get all filters",
  {
    type: z.string().optional().describe("Filter type (deals, persons, org, products, activities)")
  },
  async (params) => {
    try {
      const opts: any = {};
      if (params.type) opts.type = params.type;
      // @ts-ignore
      const response = await filtersApi.getFilters(opts);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-filter",
  "Get a specific filter by ID",
  { filterId: z.number().describe("Filter ID") },
  async ({ filterId }) => {
    try {
      // @ts-ignore
      const response = await filtersApi.getFilter(filterId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-filter",
  "Add a new filter",
  {
    name: z.string().describe("Filter name"),
    type: z.string().describe("Filter type (deals, persons, org, products, activities)"),
    conditions: z.any().describe("Filter conditions object")
  },
  async (params) => {
    try {
      const body: any = { name: params.name, type: params.type, conditions: params.conditions };
      // @ts-ignore
      const response = await filtersApi.addFilter(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-filter",
  "Update a filter",
  {
    filterId: z.number().describe("Filter ID"),
    name: z.string().optional().describe("Filter name"),
    conditions: z.any().optional().describe("Filter conditions object")
  },
  async ({ filterId, ...params }) => {
    try {
      const body: any = {};
      if (params.name) body.name = params.name;
      if (params.conditions) body.conditions = params.conditions;
      // @ts-ignore
      const response = await filtersApi.updateFilter(filterId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-filter",
  "Delete a filter",
  { filterId: z.number().describe("Filter ID") },
  async ({ filterId }) => {
    try {
      // @ts-ignore
      const response = await filtersApi.deleteFilter(filterId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- GOALS ---

server.tool(
  "get-goals",
  "Find goals with optional filtering",
  {
    type: z.string().optional().describe("Goal type"),
    title: z.string().optional().describe("Goal title"),
    isActive: z.boolean().optional().describe("Filter by active status"),
    period: z.string().optional().describe("Goal period")
  },
  async (params) => {
    try {
      const opts: any = {};
      if (params.type) opts.type = params.type;
      if (params.title) opts.title = params.title;
      if (params.isActive !== undefined) opts.is_active = params.isActive;
      if (params.period) opts.period = params.period;
      // @ts-ignore
      const response = await goalsApi.getGoals(opts);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-goal",
  "Add a new goal",
  {
    title: z.string().describe("Goal title"),
    type: z.any().describe("Goal type object"),
    assignee: z.any().describe("Goal assignee object"),
    expectedOutcome: z.any().describe("Expected outcome object"),
    duration: z.any().describe("Goal duration object")
  },
  async (params) => {
    try {
      const body: any = {
        title: params.title,
        type: params.type,
        assignee: params.assignee,
        expected_outcome: params.expectedOutcome,
        duration: params.duration
      };
      // @ts-ignore
      const response = await goalsApi.addGoal(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-goal",
  "Update a goal",
  {
    goalId: z.string().describe("Goal ID"),
    title: z.string().optional().describe("Goal title")
  },
  async ({ goalId, ...params }) => {
    try {
      const body: any = {};
      if (params.title) body.title = params.title;
      // @ts-ignore
      const response = await goalsApi.updateGoal(goalId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-goal",
  "Delete a goal",
  { goalId: z.string().describe("Goal ID") },
  async ({ goalId }) => {
    try {
      // @ts-ignore
      const response = await goalsApi.deleteGoal(goalId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-goal-results",
  "Get goal results",
  {
    goalId: z.string().describe("Goal ID"),
    periodStart: z.string().describe("Period start date (YYYY-MM-DD)"),
    periodEnd: z.string().describe("Period end date (YYYY-MM-DD)")
  },
  async ({ goalId, periodStart, periodEnd }) => {
    try {
      // @ts-ignore
      const response = await goalsApi.getGoalResult(goalId, { period_start: periodStart, period_end: periodEnd });
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- PROJECTS ---

server.tool(
  "get-projects",
  "Get all projects",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await projectsApi.getProjects();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-project",
  "Get a specific project by ID",
  { projectId: z.number().describe("Project ID") },
  async ({ projectId }) => {
    try {
      // @ts-ignore
      const response = await projectsApi.getProject(projectId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-project",
  "Add a new project",
  {
    title: z.string().describe("Project title"),
    boardId: z.number().optional().describe("Board ID"),
    phaseId: z.number().optional().describe("Phase ID"),
    description: z.string().optional().describe("Project description")
  },
  async (params) => {
    try {
      const body: any = { title: params.title };
      if (params.boardId) body.board_id = params.boardId;
      if (params.phaseId) body.phase_id = params.phaseId;
      if (params.description) body.description = params.description;
      // @ts-ignore
      const response = await projectsApi.addProject(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-project",
  "Update a project",
  {
    projectId: z.number().describe("Project ID"),
    title: z.string().optional().describe("Project title"),
    description: z.string().optional().describe("Project description"),
    status: z.string().optional().describe("Project status")
  },
  async ({ projectId, ...params }) => {
    try {
      const body: any = {};
      if (params.title) body.title = params.title;
      if (params.description) body.description = params.description;
      if (params.status) body.status = params.status;
      // @ts-ignore
      const response = await projectsApi.updateProject(projectId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-project",
  "Delete a project",
  { projectId: z.number().describe("Project ID") },
  async ({ projectId }) => {
    try {
      // @ts-ignore
      const response = await projectsApi.deleteProject(projectId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-project-tasks",
  "Get tasks in a project",
  { projectId: z.number().describe("Project ID") },
  async ({ projectId }) => {
    try {
      // @ts-ignore
      const response = await projectsApi.getProjectTasks(projectId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-project-activities",
  "Get activities in a project",
  { projectId: z.number().describe("Project ID") },
  async ({ projectId }) => {
    try {
      // @ts-ignore
      const response = await projectsApi.getProjectActivities(projectId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- TASKS ---

server.tool(
  "get-tasks",
  "Get all tasks",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await tasksApi.getTasks();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-task",
  "Get a specific task by ID",
  { taskId: z.number().describe("Task ID") },
  async ({ taskId }) => {
    try {
      // @ts-ignore
      const response = await tasksApi.getTask(taskId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-task",
  "Add a new task",
  {
    title: z.string().describe("Task title"),
    projectId: z.number().describe("Project ID"),
    dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    description: z.string().optional().describe("Task description")
  },
  async (params) => {
    try {
      const body: any = { title: params.title, project_id: params.projectId };
      if (params.dueDate) body.due_date = params.dueDate;
      if (params.description) body.description = params.description;
      // @ts-ignore
      const response = await tasksApi.addTask(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "update-task",
  "Update a task",
  {
    taskId: z.number().describe("Task ID"),
    title: z.string().optional().describe("Task title"),
    dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    done: z.number().optional().describe("Done status (0 or 1)")
  },
  async ({ taskId, ...params }) => {
    try {
      const body: any = {};
      if (params.title) body.title = params.title;
      if (params.dueDate) body.due_date = params.dueDate;
      if (params.done !== undefined) body.done = params.done;
      // @ts-ignore
      const response = await tasksApi.updateTask(taskId, body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-task",
  "Delete a task",
  { taskId: z.number().describe("Task ID") },
  async ({ taskId }) => {
    try {
      // @ts-ignore
      const response = await tasksApi.deleteTask(taskId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- ROLES ---

server.tool(
  "get-roles",
  "Get all roles",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await rolesApi.getRoles();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-role",
  "Get a specific role by ID",
  { roleId: z.number().describe("Role ID") },
  async ({ roleId }) => {
    try {
      // @ts-ignore
      const response = await rolesApi.getRole(roleId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-role-assignments",
  "Get role assignments",
  { roleId: z.number().describe("Role ID") },
  async ({ roleId }) => {
    try {
      // @ts-ignore
      const response = await rolesApi.getRoleAssignments(roleId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-role-settings",
  "Get role settings",
  { roleId: z.number().describe("Role ID") },
  async ({ roleId }) => {
    try {
      // @ts-ignore
      const response = await rolesApi.getRoleSettings(roleId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-role-pipelines",
  "Get pipelines visible to a role",
  { roleId: z.number().describe("Role ID") },
  async ({ roleId }) => {
    try {
      // @ts-ignore
      const response = await rolesApi.getRolePipelines(roleId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-role",
  "Add a new role",
  {
    name: z.string().describe("Role name"),
    parentRoleId: z.number().optional().describe("Parent role ID")
  },
  async (params) => {
    try {
      const body: any = { name: params.name };
      if (params.parentRoleId) body.parent_role_id = params.parentRoleId;
      // @ts-ignore
      const response = await rolesApi.addRole(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- WEBHOOKS ---

server.tool(
  "get-webhooks",
  "Get all webhooks",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await webhooksApi.getWebhooks();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-webhook",
  "Add a new webhook",
  {
    subscriptionUrl: z.string().describe("Webhook subscription URL"),
    eventAction: z.string().describe("Event action (e.g., added, updated, deleted, merged, *)"),
    eventObject: z.string().describe("Event object (e.g., deal, person, organization, *)")
  },
  async (params) => {
    try {
      const body: any = {
        subscription_url: params.subscriptionUrl,
        event_action: params.eventAction,
        event_object: params.eventObject
      };
      // @ts-ignore
      const response = await webhooksApi.addWebhook(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-webhook",
  "Delete a webhook",
  { webhookId: z.number().describe("Webhook ID") },
  async ({ webhookId }) => {
    try {
      // @ts-ignore
      const response = await webhooksApi.deleteWebhook(webhookId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- CURRENCIES ---

server.tool(
  "get-currencies",
  "Get all supported currencies",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await currenciesApi.getCurrencies();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- CALL LOGS ---

server.tool(
  "get-call-logs",
  "Get all call logs",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await callLogsApi.getCallLogs();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-call-log",
  "Get a specific call log by ID",
  { callLogId: z.string().describe("Call log ID") },
  async ({ callLogId }) => {
    try {
      // @ts-ignore
      const response = await callLogsApi.getCallLog(callLogId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-call-log",
  "Add a new call log",
  {
    subject: z.string().optional().describe("Call subject"),
    toPhoneNumber: z.string().describe("Phone number called"),
    outcome: z.string().describe("Call outcome"),
    startTime: z.string().describe("Call start time (ISO 8601)"),
    endTime: z.string().describe("Call end time (ISO 8601)"),
    dealId: z.number().optional().describe("Associated deal ID"),
    personId: z.number().optional().describe("Associated person ID"),
    orgId: z.number().optional().describe("Associated organization ID")
  },
  async (params) => {
    try {
      const body: any = {
        to_phone_number: params.toPhoneNumber,
        outcome: params.outcome,
        start_time: params.startTime,
        end_time: params.endTime
      };
      if (params.subject) body.subject = params.subject;
      if (params.dealId) body.deal_id = params.dealId;
      if (params.personId) body.person_id = params.personId;
      if (params.orgId) body.org_id = params.orgId;
      // @ts-ignore
      const response = await callLogsApi.addCallLog(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "delete-call-log",
  "Delete a call log",
  { callLogId: z.string().describe("Call log ID") },
  async ({ callLogId }) => {
    try {
      // @ts-ignore
      const response = await callLogsApi.deleteCallLog(callLogId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- FIELD METADATA ---

server.tool(
  "get-deal-fields",
  "Get all deal fields",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await dealFieldsApi.getDealFields();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-person-fields",
  "Get all person fields",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await personFieldsApi.getPersonFields();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-organization-fields",
  "Get all organization fields",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await organizationFieldsApi.getOrganizationFields();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-product-fields",
  "Get all product fields",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await productFieldsApi.getProductFields();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-note-fields",
  "Get all note fields",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await noteFieldsApi.getNoteFields();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-activity-fields",
  "Get all activity fields",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await activityFieldsApi.getActivityFields();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- LEAD LABELS & SOURCES ---

server.tool(
  "get-lead-labels",
  "Get all lead labels",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await leadLabelsApi.getLeadLabels();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-lead-sources",
  "Get all lead sources",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await leadSourcesApi.getLeadSources();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- ORGANIZATION RELATIONSHIPS ---

server.tool(
  "get-organization-relationships",
  "Get organization relationships",
  { orgId: z.number().describe("Organization ID") },
  async ({ orgId }) => {
    try {
      // @ts-ignore
      const response = await organizationRelationshipsApi.getOrganizationRelationships(orgId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "add-organization-relationship",
  "Add an organization relationship",
  {
    orgId: z.number().describe("Organization ID"),
    relatedOrgId: z.number().describe("Related organization ID"),
    type: z.string().describe("Relationship type (parent or related)")
  },
  async (params) => {
    try {
      const body: any = {
        org_id: params.orgId,
        related_org_id: params.relatedOrgId,
        type: params.type
      };
      // @ts-ignore
      const response = await organizationRelationshipsApi.addOrganizationRelationship(body);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- PERMISSION SETS ---

server.tool(
  "get-permission-sets",
  "Get all permission sets",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await permissionSetsApi.getPermissionSets();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-permission-set",
  "Get a specific permission set by ID",
  { permissionSetId: z.number().describe("Permission set ID") },
  async ({ permissionSetId }) => {
    try {
      // @ts-ignore
      const response = await permissionSetsApi.getPermissionSet(permissionSetId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- RECENTS ---

server.tool(
  "get-recents",
  "Get recent changes",
  {
    sinceTimestamp: z.string().describe("Timestamp to get changes since (ISO 8601)"),
    items: z.string().optional().describe("Comma-separated list of item types")
  },
  async (params) => {
    try {
      const opts: any = { since_timestamp: params.sinceTimestamp };
      if (params.items) opts.items = params.items;
      // @ts-ignore
      const response = await recentsApi.getRecents(opts);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- USER SETTINGS ---

server.tool(
  "get-user-settings",
  "Get current user settings",
  {},
  async () => {
    try {
      // @ts-ignore
      const response = await userSettingsApi.getUserSettings();
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// --- MAILBOX ---

server.tool(
  "get-mail-threads",
  "Get mail threads",
  {
    folder: z.string().optional().describe("Mail folder (inbox, drafts, sent, archive)")
  },
  async (params) => {
    try {
      const opts: any = {};
      if (params.folder) opts.folder = params.folder;
      // @ts-ignore
      const response = await mailboxApi.getMailThreads(opts);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-mail-thread",
  "Get a specific mail thread by ID",
  { threadId: z.number().describe("Mail thread ID") },
  async ({ threadId }) => {
    try {
      // @ts-ignore
      const response = await mailboxApi.getMailThread(threadId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

server.tool(
  "get-mail-thread-messages",
  "Get messages in a mail thread",
  { threadId: z.number().describe("Mail thread ID") },
  async ({ threadId }) => {
    try {
      // @ts-ignore
      const response = await mailboxApi.getMailThreadMessages(threadId);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }], isError: true };
    }
  }
);

// === PROMPTS ===

// Prompt for getting all deals
server.prompt(
  "list-all-deals",
  "List all deals in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all deals in my Pipedrive account, showing their title, value, status, and stage."
      }
    }]
  })
);

// Prompt for getting all persons
server.prompt(
  "list-all-persons",
  "List all persons in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all persons in my Pipedrive account, showing their name, email, phone, and organization."
      }
    }]
  })
);

// Prompt for getting all pipelines
server.prompt(
  "list-all-pipelines",
  "List all pipelines in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all pipelines in my Pipedrive account, showing their name and stages."
      }
    }]
  })
);

// Prompt for analyzing deals
server.prompt(
  "analyze-deals",
  "Analyze deals by stage",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please analyze the deals in my Pipedrive account, grouping them by stage and providing total value for each stage."
      }
    }]
  })
);

// Prompt for analyzing contacts
server.prompt(
  "analyze-contacts",
  "Analyze contacts by organization",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please analyze the persons in my Pipedrive account, grouping them by organization and providing a count for each organization."
      }
    }]
  })
);

// Prompt for analyzing leads
server.prompt(
  "analyze-leads",
  "Analyze leads by status",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please search for all leads in my Pipedrive account and group them by status."
      }
    }]
  })
);

// Prompt for pipeline comparison
server.prompt(
  "compare-pipelines",
  "Compare different pipelines and their stages",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all pipelines in my Pipedrive account and compare them by showing the stages in each pipeline."
      }
    }]
  })
);

// Prompt for finding high-value deals
server.prompt(
  "find-high-value-deals",
  "Find high-value deals",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please identify the highest value deals in my Pipedrive account and provide information about which stage they're in and which person or organization they're associated with."
      }
    }]
  })
);

// Get transport type from environment variable (default to stdio)
const transportType = process.env.MCP_TRANSPORT || 'stdio';

if (transportType === 'sse') {
  // SSE transport - create HTTP server
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const endpoint = process.env.MCP_ENDPOINT || '/message';
  const baseUrl = OAUTH_BASE_URL || `http://localhost:${port}`;

  // Store active transports by session ID
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // === OAuth 2.0 Endpoints ===

    // OAuth Authorization Server Metadata (RFC 8414)
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      }));
      return;
    }

    // Dynamic Client Registration (RFC 7591)
    if (req.method === 'POST' && url.pathname === '/register') {
      try {
        const body = await readBody(req);
        const registration = JSON.parse(body);
        // Accept any client registration but always return our fixed client
        const clientId = `mcp-client-${crypto.randomBytes(16).toString('hex')}`;
        const clientSecret = crypto.randomBytes(32).toString('hex');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          client_name: registration.client_name || 'MCP Client',
          redirect_uris: registration.redirect_uris || [],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
        }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
      }
      return;
    }

    // Authorization endpoint - GET shows login form
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const clientId = url.searchParams.get('client_id') || '';
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const state = url.searchParams.get('state') || '';
      const codeChallenge = url.searchParams.get('code_challenge') || '';
      const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'plain';

      if (!redirectUri) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request', error_description: 'redirect_uri is required' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderLoginPage(clientId, redirectUri, state, codeChallenge, codeChallengeMethod));
      return;
    }

    // Authorization endpoint - POST handles login
    if (req.method === 'POST' && url.pathname === '/authorize') {
      const clientIp = getClientIp(req);
      if (!checkLoginRateLimit(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'text/html' });
        res.end(renderLoginPage('', '', '', '', '', 'Too many login attempts. Try again in 15 minutes.'));
        return;
      }

      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const email = params.get('email') || '';
      const password = params.get('password') || '';
      const clientId = params.get('client_id') || '';
      const redirectUri = params.get('redirect_uri') || '';
      const state = params.get('state') || '';
      const codeChallenge = params.get('code_challenge') || '';
      const codeChallengeMethod = params.get('code_challenge_method') || 'plain';

      // Verify credentials
      if (email !== OAUTH_USER_EMAIL || password !== OAUTH_USER_PASSWORD) {
        console.error(`Failed login attempt from ${clientIp} for email: ${email}`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderLoginPage(clientId, redirectUri, state, codeChallenge, codeChallengeMethod, 'Invalid email or password'));
        return;
      }

      // Generate authorization code
      const code = crypto.randomBytes(32).toString('hex');
      authCodes.set(code, {
        clientId,
        redirectUri,
        codeChallenge: codeChallenge || undefined,
        codeChallengeMethod: codeChallengeMethod || undefined,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      });

      // Redirect back with code
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set('code', code);
      if (state) redirectUrl.searchParams.set('state', state);

      console.error(`Successful login from ${clientIp}, redirecting to ${redirectUri}`);
      res.writeHead(302, { Location: redirectUrl.toString() });
      res.end();
      return;
    }

    // Token endpoint
    if (req.method === 'POST' && url.pathname === '/token') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');

      if (grantType === 'authorization_code') {
        const code = params.get('code') || '';
        const codeVerifier = params.get('code_verifier') || '';
        const storedCode = authCodes.get(code);

        if (!storedCode || storedCode.expiresAt < Date.now()) {
          authCodes.delete(code);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }));
          return;
        }

        // Verify PKCE code challenge
        if (storedCode.codeChallenge) {
          let valid = false;
          if (storedCode.codeChallengeMethod === 'S256') {
            const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
            valid = hash === storedCode.codeChallenge;
          } else {
            valid = codeVerifier === storedCode.codeChallenge;
          }
          if (!valid) {
            authCodes.delete(code);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid code verifier' }));
            return;
          }
        }

        authCodes.delete(code);
        const accessToken = generateAccessToken(storedCode.clientId);
        const refreshToken = generateRefreshToken(storedCode.clientId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: OAUTH_TOKEN_EXPIRY,
          refresh_token: refreshToken,
        }));
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshToken = params.get('refresh_token') || '';
        const stored = refreshTokens.get(refreshToken);

        if (!stored || stored.expiresAt < Date.now()) {
          refreshTokens.delete(refreshToken);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }));
          return;
        }

        refreshTokens.delete(refreshToken);
        const accessToken = generateAccessToken(stored.clientId);
        const newRefreshToken = generateRefreshToken(stored.clientId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: OAUTH_TOKEN_EXPIRY,
          refresh_token: newRefreshToken,
        }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    // === MCP Endpoints ===

    if (req.method === 'GET' && url.pathname === '/sse') {
      const authResult = verifyRequestAuthentication(req);
      if (!authResult.ok) {
        res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: authResult.message }));
        return;
      }

      // Establish SSE connection
      console.error('New SSE connection request');
      const transport = new SSEServerTransport(endpoint, res);

      // Store transport by session ID
      transports.set(transport.sessionId, transport);

      transport.onclose = () => {
        console.error(`SSE connection closed: ${transport.sessionId}`);
        transports.delete(transport.sessionId);
      };

      try {
        await server.connect(transport);
        console.error(`SSE connection established: ${transport.sessionId}`);
      } catch (err) {
        console.error('Failed to establish SSE connection:', err);
        transports.delete(transport.sessionId);
      }
    } else if (req.method === 'POST' && url.pathname === endpoint) {
      const authResult = verifyRequestAuthentication(req);
      if (!authResult.ok) {
        res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: authResult.message }));
        return;
      }

      // Handle incoming message
      const sessionId = url.searchParams.get('sessionId') || req.headers['x-session-id'] as string;

      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing sessionId' }));
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      req.on('error', err => {
        console.error('Error receiving POST message body:', err);
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
      });

      try {
        await transport.handlePostMessage(req, res);
      } catch (err) {
        console.error('Error handling POST message:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    } else if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'sse' }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  httpServer.listen(port, () => {
    console.error(`Pipedrive MCP Server (SSE) listening on port ${port}`);
    console.error(`SSE endpoint: http://localhost:${port}/sse`);
    console.error(`Message endpoint: http://localhost:${port}${endpoint}`);
    if (OAUTH_USER_EMAIL) {
      console.error(`OAuth 2.0 enabled - login required`);
      console.error(`OAuth metadata: http://localhost:${port}/.well-known/oauth-authorization-server`);
    } else {
      console.error(`OAuth 2.0 disabled - no credentials configured`);
    }
  });
} else {
  // Default: stdio transport
  const transport = new StdioServerTransport();
  server.connect(transport).catch(err => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });

  console.error("Pipedrive MCP Server started (stdio transport)");
}
