# GTM Engineering Portfolio — Jan Mikeš

Prague-based GTM Engineer. This repo contains production infrastructure I've built for GTM automation, CRM integration, and AI-powered workflows.

## What's here

### [n8n MCP Server](./n8n-mcp-server)
Custom MCP server connecting Claude to a self-hosted n8n instance. Enables natural language workflow creation and management directly from Claude Code.
- Self-hosted on Digital Ocean (Frankfurt) for EU data residency
- Create, read, update, delete workflows via natural language
- Full coverage of the n8n REST API — workflows, executions, credentials, variables, tags, users, webhooks, source control, audit
- OAuth2 + JWT auth for remote SSE deployments; stdio for local Claude Desktop
- Zod-validated tool inputs on every call
- Production-tested at Dateio across 8 European markets

### [Pipedrive MCP Server](./pipedrive-mcp-server)
Custom MCP server connecting Claude to Pipedrive CRM. Natural language queries return structured deal data, pipeline stats, contact info without touching the CRM UI.
- Query deals, contacts, organizations, activities, leads, products, projects in plain English
- Custom field support on every `get-*` call
- Pipeline health checks, stalled deal detection, conversion stats, merge operations
- Built-in rate limiting (bottleneck) + optional JWT auth
- Forked from [juhokoskela/pipedrive-mcp-server](https://github.com/juhokoskela/pipedrive-mcp-server), extended for production use on a 20+ user, multi-country Pipedrive instance

### [GTM Skills](./skills)
Custom Claude Code skill files that encode best practices for GTM engineering work:
- **`n8n/`** — Workflow architecture, Code node patterns, error handling, webhook design, Pipedrive + Microsoft Graph reference
- **`clay/`** — Clay table design, waterfall enrichment, credit economics
- **`cold-email/`** — Copywriting frameworks, deliverability, sequence design
- **`list-building/`** — Sales Navigator boolean search, ICP matrices, lead sourcing
- **`signal-sourcer/`** — Intent signals, scoring, trigger mapping
- **`linkedin-ads/`** — B2B LinkedIn campaign setup, targeting, bid strategy
- **`linkedin-content/`** — Organic content strategy for founders and GTM leaders
- **`gtm-philosophy/`** — Core GTM principles and multi-channel coordination
- **`personalization-playbooks/`** — Personalization levels per outreach category (Inbound / Postbound / Bridgebound / Outbound)

## Architecture Philosophy

- **n8n orchestrates, Clay enriches, CRM stores.** Clay is an enrichment API endpoint, not a workflow platform. n8n owns the control flow, Clay owns the data waterfall, Pipedrive owns the source of truth.
- **Self-hosted n8n on EU infrastructure.** Prospect data never leaves the EU — a hard requirement for DACH enterprise clients. Frankfurt region on Digital Ocean for both n8n and the MCP servers.
- **MCP as the interface layer.** Natural language replaces manual CRM/automation UI for speed. Every tool input is Zod-validated so LLM mistakes fail fast and loudly instead of half-completing.
- **Thin wrappers, not reimplementations.** The MCP servers proxy directly to the underlying REST APIs. No state, no database, no caching — upgrades are trivial and the surface area is auditable.

## Setup

Each component has its own README with setup instructions. You'll need:
- A VPS (I use Digital Ocean, Frankfurt region) for n8n and the MCP servers
- Node.js 18+
- A Pipedrive API token (for the Pipedrive MCP)
- An n8n instance URL and API key (for the n8n MCP)

## Audit This Repo

If you want a structured technical review of the code quality, architecture, and security practices, see [`AUDIT_PROMPT.md`](./AUDIT_PROMPT.md) — a ready-made Claude prompt that walks through the entire repo.

## Contact

me@mikesjan.cz · [LinkedIn](https://www.linkedin.com/in/jan-mikes21)
