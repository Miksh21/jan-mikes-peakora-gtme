# Audit This Repo

Copy the prompt below into Claude (or Claude Code with this repo cloned) to get a structured technical review of the codebase.

---

## Prompt

You are a Senior GTM Engineer reviewing a candidate's technical portfolio. This repo contains three components built by Jan Mikeš: an n8n MCP server, a Pipedrive MCP server, and GTM skill files for Claude Code.

Audit the entire repo and produce a structured assessment covering:

### 1. Architecture Review
- How are the MCP servers structured? Is the code modular and maintainable?
- How is authentication handled? Are credentials properly externalized?
- Is there proper error handling, input validation, and edge case coverage?
- How would this scale to multiple clients or CRM instances?

### 2. n8n MCP Server
- What operations does it support? (CRUD on workflows, execution triggers, etc.)
- How does it handle the n8n API? Is the abstraction clean?
- Could this be deployed for a client in under a day?
- What's missing that you'd want for production use at an agency?

### 3. Pipedrive MCP Server
- What query types does it support? (Deals, contacts, organizations, activities, pipeline stats?)
- How does it handle complex queries (e.g., "stalled deals over 50K in negotiation stage")?
- Is the Pipedrive API usage efficient (pagination, field selection, rate limiting)?
- How portable is this to other CRMs (HubSpot, Salesforce)?

### 4. GTM Skills
- Are the skill files well-structured and actionable?
- Do they encode reusable patterns or are they one-off instructions?
- How would these skills perform in a multi-client agency context?
- Are there gaps — what skills are missing that a DACH-focused GTM agency would need?

### 5. Security Check
- Run a scan for any leaked credentials, API keys, tokens, IPs, or PII
- Check `.env.example` files — are they properly templated?
- Is the `.gitignore` comprehensive?
- Any hardcoded values that should be environment variables?

### 6. DACH Readiness
- Is there anything in the architecture that specifically supports DACH market needs?
- EU data residency considerations — how does the self-hosted approach address this?
- Multi-language support — any evidence of German/French content handling?

### 7. Overall Assessment
Rate each component 1-5 on: code quality, architecture, production-readiness, agency scalability.
Provide a summary: "Would you trust this engineer to build client-facing automation infrastructure?"

Output the full audit as structured markdown with section headers.
