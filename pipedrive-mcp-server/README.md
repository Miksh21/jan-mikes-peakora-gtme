# Pipedrive MCP Server

[Model Context Protocol](https://modelcontextprotocol.io/) server that lets Claude query and manage a Pipedrive CRM in natural language. Every Pipedrive resource I actually use in production GTM work — deals, persons, organizations, leads, activities, notes, pipelines, products, projects, mail threads, files, webhooks, goals, roles, filters — is exposed as an MCP tool with a Zod-validated input schema.

## Attribution

This server was originally forked from [juhokoskela/pipedrive-mcp-server](https://github.com/juhokoskela/pipedrive-mcp-server) (MIT, © Will Dent). I kept the upstream architecture and added / extended tools, rate limiting, SSE transport deployment, and production hardening for a real 20+ user Pipedrive instance.

## What it does

- **CRUD on every major Pipedrive resource** — deals, persons, organizations, leads, products, projects, activities, tasks, notes, files, pipelines, stages, users, roles, goals, filters, webhooks, call logs
- **Search** across deals / persons / orgs / leads / products / "all"
- **Custom fields** returned on every `get-*` tool (not just standard fields)
- **Flexible deal filtering** — by owner, status, date range, stage, value range, pipeline, search term
- **Merge operations** — merge deals, merge persons, merge organizations (used daily for dedup)
- **Pipeline analytics** — conversion stats, movement stats, stalled deals, stage-by-stage health
- **Pipedrive API v1 + v2** via the official `pipedrive` npm SDK

## Production features

- **Rate limiting** (`bottleneck`) — configurable `PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS` and `PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT` prevent 429s. Every Pipedrive API call goes through the rate-limited wrapper.
- **JWT authentication** for SSE transport — when `MCP_JWT_SECRET` is set, every `/sse` and `/message` request must present a `Bearer` token. Lets you expose the server publicly without exposing the CRM.
- **Dual transport** — `stdio` for local Claude Desktop, `sse` for Docker / remote.
- **Docker + DigitalOcean App Platform** — `Dockerfile`, `docker-compose.yml`, and `app-spec.yaml` all included. Frankfurt region for EU data residency.

## Environment

Copy `.env.example` to `.env` and fill in:

- `PIPEDRIVE_API_TOKEN` — from your Pipedrive profile
- `PIPEDRIVE_DOMAIN` — e.g. `your-company.pipedrive.com`

Optional: JWT auth (`MCP_JWT_*`), rate limiting (`PIPEDRIVE_RATE_LIMIT_*`), transport (`MCP_TRANSPORT`, `MCP_PORT`, `MCP_ENDPOINT`).

## Run

```bash
npm install
npm run build
npm start
```

Or with Docker:

```bash
cp .env.example .env
# fill in credentials
docker compose up -d
```

## Examples

[`examples/pipedrive-sharepoint-file-linker.json`](./examples/pipedrive-sharepoint-file-linker.json) — n8n workflow that runs hourly, scans Pipedrive for SharePoint URLs in activities/notes/files, resolves them via Microsoft Graph, and auto-uploads the file (or adds a folder note) to the right Pipedrive entity. Paired with this MCP server during development.

## Portability

The tool layer is thin — every tool is `(input) → pipedriveClient.someCall(input) → response`. Porting to HubSpot or Salesforce would mean swapping the SDK and rewriting the ~30 thin wrappers; the validation, rate-limit, and transport layers stay identical. I've used the same pattern for n8n ([`../n8n-mcp-server`](../n8n-mcp-server)).

## License

MIT — see root [`LICENSE`](../LICENSE).
