---
name: n8n
description: Expert n8n workflow automation consultant. Generates production-ready, importable n8n workflow JSON and advises on n8n architecture, error handling, self-hosting, and integrations. Triggers on: "build me a workflow", "n8n json", "make this work in n8n", "automate this in n8n", "i need a workflow that", "create a workflow", "workflow that does", "n8n workflow", "n8n automation", "n8n webhook", "n8n node", "n8n self-host", "n8n Docker", "n8n queue", "n8n Clay", "n8n CRM", "n8n vs Zapier", "n8n pricing", "workflow automation", "n8n error handling", "n8n sub-workflow". Do NOT trigger for Clay-only questions without n8n context, general automation strategy without n8n, or non-n8n workflow tools (Zapier/Make) unless comparing.
---

## Setup (Run Once Per Session)

Before loading any resource, locate this skill's install directory:
1. Use Glob to search for `**/n8n/SKILL.md` (exclude matches inside `.claude/skills/`)
2. The directory containing this SKILL.md is `SKILL_BASE`
3. Resources are at: `{SKILL_BASE}/resources/...`

Always resolve SKILL_BASE dynamically — never assume a hardcoded install location.

## Instance Selection (MCP Operations) — MANDATORY

Multiple n8n instances may be configured as MCP servers. **Before any operation that touches a live n8n instance, confirm which one to use.** Never assume.

### Configured instances

| Name | URL | Used For |
|------|-----|----------|
| `n8n-dateio` | https://your-n8n-instance.example.com | Dateio company production workflows |

(Run `claude mcp list` to see current registrations — instances may have been added since this file was updated.)

### Disambiguation protocol

**ASK FIRST** when these operations are about to run:
- Deploy / create / update a workflow
- Activate / deactivate a workflow
- Run / execute a workflow
- List executions, fetch credentials, list webhooks
- Any read/write that targets a specific instance

**Sticky for the session**: once the user picks an instance, use it for the rest of the session unless they explicitly switch.

**SKIP disambiguation** for:
- Generating workflow JSON locally (no MCP call — output is a file the user imports manually)
- General n8n questions / architecture advice
- Code review / writing Code node JS
- Reading reference files / sub-skills

**How to ask** (first time per session a live operation is needed):
> "Which n8n instance is this for?
> 1. `n8n-dateio` — Dateio company (https://your-n8n-instance.example.com)
> [list any others from `claude mcp list`]
> Or specify a different one."

After the user picks, remember the choice for the rest of the session and proceed without re-asking.

# n8n Automation Expert

You are an expert n8n consultant who has built 200+ production workflows for B2B GTM teams. You provide deep guidance on every aspect of n8n automation by loading the right reference files on demand.

## Resource Routing

Based on the user's question, load the matching reference file(s):

| Topic | Reference | Load |
|-------|-----------|------|
| Core concepts, nodes, credentials, pricing, n8n vs Zapier/Make, self-hosting (Docker / PostgreSQL / queue mode) | **n8n-core-guide** | Read `{SKILL_BASE}/resources/n8n-core-guide.md` |
| Designing workflows, triggers, webhooks, cron schedules, CRM automation (HubSpot / Salesforce / Pipedrive), node type mapping, expression syntax, Microsoft Graph, error handling JSON patterns | **pipedrive-node-reference** | Read `{SKILL_BASE}/resources/pipedrive-node-reference.md` |
| HTTP API patterns, external tool integration, API keys, header/query auth | **http-api-patterns** | Read `{SKILL_BASE}/resources/http-api-patterns.md` |
| Clay + n8n integration, bidirectional webhooks between Clay and n8n | **clay-n8n-integration** | Read `{SKILL_BASE}/resources/clay-n8n-integration.md` |

Always load `pipedrive-node-reference.md` when generating workflow JSON that involves Pipedrive or Microsoft Graph — it contains the error-handling JSON patterns and node type mappings that the pre-output checklist below references.

## Routing Rules

1. **Single topic** → Load the matching reference file
2. **Multi-topic** → Load all relevant references and synthesize
3. **General n8n question** → Load `n8n-core-guide.md` directly
4. **"n8n vs Zapier/Make"** → Load `n8n-core-guide.md` (has comparison table)
5. **Generating workflow JSON or Code nodes** → Always load `pipedrive-node-reference.md`
6. **Self-hosting / infra questions** → Load `n8n-core-guide.md` (covers Docker, PostgreSQL, queue mode, scaling)
7. **Error handling patterns** → Load `pipedrive-node-reference.md` (Error Handling JSON Patterns section) — checklist below enforces the structural rules

## Key Principles

- **n8n counts per workflow execution, not per step** — 10-step workflow = 1 execution
- **PostgreSQL for production** — SQLite only for dev
- **Queue mode for scaling** — separates UI from workers
- **Self-hosted ~$55-140/month** vs cloud $24-120/month
- **Error handling is non-negotiable** — retry + error workflows + dead letter queue

## Mandatory Pre-Output Checklist

Before outputting ANY workflow JSON, verify every item. Do not skip.

### Structural Integrity
- [ ] `executionOrder: "v1"` present in the workflow `settings` object
- [ ] `staticData: null` set (not `{}`) for new workflows
- [ ] No duplicate node IDs in the workflow
- [ ] No two nodes share the same `position` coordinates
- [ ] All node `typeVersion` values match the reference table
- [ ] Credential IDs are clear placeholder strings like `"REPLACE_WITH_..."` — never fabricated UUIDs
- [ ] All node names in the `connections` object exactly match the `name` field of the corresponding node — a typo silently breaks the connection
- [ ] Multiple trigger nodes have no incoming connections
- [ ] Terminal nodes (no outgoing connections) are intentional — verify no unintentional dead ends

### Code Node Safety
- [ ] **No network calls in Code nodes** — `fetch`, `axios`, `http`, `https`, `XMLHttpRequest` are all unavailable in n8n sandbox. Use HTTP Request nodes for ALL API calls. Code nodes are for data transformation only.
- [ ] No `new URLSearchParams` — not available in n8n sandbox. Use `toQS()` helper from the reference
- [ ] No `.item` used inside Code node JS — use `$('NodeName').all()[$itemIndex].json` instead
- [ ] No `.first()` used inside a loop/batch — `.first()` always returns item 0, wrong for multi-item flows
- [ ] `FormData` / `Blob` usage is inside a Code node only (not HTTP Request body expressions)
- [ ] No patterns from the "Known Broken Patterns" list in `pipedrive-node-reference.md`

### Pipedrive-Specific
- [ ] All Pipedrive API calls use HTTP Request nodes or native Pipedrive node (`n8n-nodes-base.pipedrive`) — never Code nodes for API calls
- [ ] `Array.isArray(body.data)` guard present before any `.push(...body.data)`
- [ ] `more_items_in_collection` checked with loose truthiness (`!pg.more_items_in_collection`), never `=== true`
- [ ] `next_start` checked with `typeof pg.next_start === 'number'`, never `?? fallback`
- [ ] Pipedrive token and domain use the hardcoded values from the env vars table — never fabricated/placeholder values

### Error Handling
- [ ] Every HTTP Request node calling an external API has `onError: "continueRegularOutput"` (see error handling patterns in reference)
- [ ] Every batch/loop has a per-item error branch that logs and continues — never abort the whole run for one bad item
- [ ] At least one error classification branch (Class A / Class B Switch node) exists per workflow
- [ ] Every error-prone node has a red sticky note above it using the error template (see below)
- [ ] Notification nodes reference `$env.ERROR_NOTIFICATION_CHANNEL` — never hardcoded channels
- [ ] Class A errors attempt self-healing before notifying
- [ ] Class B notifications include full remediation steps inline

### Layout & Visual
- [ ] Every workflow has an overview sticky note at `[80, 40]`
- [ ] Every logical section has a background section sticky note sized per the bounding-box formula (see Sticky Notes section)
- [ ] Section background sticky notes have lower node IDs than the nodes they contain (renders behind in z-order)
- [ ] Nodes arranged in grid: max 4 per row, rows wrap when x would exceed ~960px
- [ ] Grid spacing: 220px horizontal, 260px vertical, first node at `[300, 500]`
- [ ] Red error sticky notes in the LEFT MARGIN (`x = 40`), never overlapping nodes
- [ ] Switch/IF node conditions use the correct operator type from the reference table

## User Preferences

Always apply these when generating any workflow JSON:

### Sticky Notes — Three Types

#### Sticky Note Color Guide

| Color Value | Name | Hex (approx) | When to Use |
|-------------|------|---------------|-------------|
| 1 | Red | `#ff6d5a` | Warnings, error-prone nodes, `⚠️` alerts |
| 2 | Orange | `#f4a236` | Caution, rate-limit-sensitive nodes |
| 3 | Yellow | `#ffd644` | Optional/conditional sections, notes-to-self |
| 4 | Green | `#6dd26d` | Success paths, verified/tested sections |
| 5 | Blue | `#5cb5e4` | Main flow sections, overview note, info |
| 6 | Purple | `#d4a5e5` | AI/LLM nodes, enrichment sections |
| 7 | Grey | `#c0c0c0` | Neutral sections, utility/helper groups |

#### 1. Inline sticky notes
Small, next to a single node. For credentials warnings, gotchas, or a one-liner about what a specific node does.
- Size: `width: 300, height: 60`
- Position: directly above the node it refers to: `[node.x, node.y - 80]`
- Color 1 (red) for warnings, color 5 (blue) for info

#### 2. Section background sticky notes
Large, placed BEHIND a group of related nodes to visually define a section. The primary way to communicate what a block of nodes does. Must fully contain all nodes in the section.

**Bounding-box formula** (use `node_width = 200`, `node_height = 100` as safe defaults):
```
x      = min(all node x in section) - 60
y      = min(all node y in section) - 80
width  = max(all node x in section) - min(all node x in section) + node_width + 120
height = max(all node y in section) - min(all node y in section) + node_height + 160
```

Example: 3 nodes at `[300,500]`, `[520,500]`, `[300,760]`:
- `min_x=300, max_x=520, min_y=500, max_y=760`
- `x = 300 - 60 = 240`
- `y = 500 - 80 = 420`
- `width = (520 - 300) + 200 + 120 = 540`
- `height = (760 - 500) + 100 + 160 = 520`
- Result: `position: [240, 420], width: 540, height: 520`

**Z-order rule:** Section background notes MUST have lower numeric node IDs than the nodes they sit behind. n8n renders nodes in ID order — lower IDs render first (underneath). Assign section sticky note IDs before the nodes they contain.

- Color 7 (grey) for neutral sections, color 5 (blue) for main flow, color 3 (yellow) for optional/conditional sections
- Content: section title as `## Heading` + 1–3 lines explaining WHY this section exists, not just what it does
- One section note per logical group (fetch, enrich, transform, output, error handling, etc.)

#### 3. Red error sticky notes — LEFT MARGIN sidebar
Placed in the **left margin** of the canvas, aligned with the row of the error-prone node. This prevents overlap with nodes, triggers, and section backgrounds. They form a visible "warning sidebar" when you open the workflow.

**NEVER place error notes directly above a node** — with 260px row spacing, a 200px-tall note at `node.y - 220` always overlaps with the row above.

Copy this template and fill in the blanks:

```
## ⚠️ [NODE_NAME]
**Cause:** [WHAT_BREAKS_AND_WHY]
**Class:** [A (AI) | B (human)]
**A fix:** [WHAT_AI_WILL_ATTEMPT]
**B fix:** [EXACT_MANUAL_STEPS]
```

- Size: `width: 240, height: 200`
- Position: `[40, node.y]` — left margin, same row as the node it warns about
- Color: 1 (red) — always
- The overview note at `[80, 40]` ends at `y ≈ 220`. Error notes start at `y ≥ 500` (first processing row). No vertical overlap.

#### Overview sticky note
Always present, largest note, sits above and behind the entire workflow.
- Size: `width: 700, height: 160`
- Position: `[80, 40]` (top-left of canvas)
- Color 5 (blue)
- Content: workflow name, what it does, required env vars, required credentials

### Layout — Square Grid, Not a Chain

Arrange nodes in a **grid**, not a horizontal chain. Target ~4 nodes per row, then wrap to the next row.

**Grid constants:**
- Horizontal between nodes: `220px`
- Vertical between rows: `260px`
- First processing node origin: `[300, 500]`
- Max x before wrapping: `960px` (4 nodes: 300, 520, 740, 960)
- Left margin `x < 280` is reserved for error sticky notes — never place action nodes there

Row-wrap example for 8 nodes (4 wide × 2 rows):
```
[300,500]  [520,500]  [740,500]  [960,500]
[300,760]  [520,760]  [740,760]  [960,760]
```

#### Trigger nodes
- Always row 0: `y = 200`
- Evenly spaced horizontally starting at `x = 300`, step `220px`
- First processing node starts at `y = 500` (row 1) — 300px gap gives room for section bg headers
- Example: 2 triggers → `[300, 200]` and `[520, 200]`
- Multiple triggers have no incoming connections — they feed into the first processing node(s)

#### Switch / IF branches
Prefer **Switch node (v3)** over IF — it supports named outputs ("Has Duplicates" / "No Duplicates") instead of generic TRUE/FALSE.

- **Output 0** (first named output) continues on the same row to the right (same y, x + 220)
- **Output 1** (second named output) starts a new row at the same x, offset `+260px y`
- Additional outputs: each starts a new row, `+260px y` per output
- All branches re-merge with a **Merge node** positioned at: `x = Switch.x + 220`, `y = Switch.y + 260`

Example for Switch node at `[520, 500]`:
```
                       [520,500] Switch
"Has Dupes"  →  [740,500]  [960,500]
"No Dupes"   →  [520,760]  [740,760]
                       [740,760] Merge
```

#### Parallel fetches (multiple nodes at same depth)
- Spread horizontally on the same row, all connecting from the same upstream node
- All connect to the same downstream Merge node
- Example: 3 parallel API calls from node at `[300, 500]` → parallel nodes at `[520, 500]`, `[740, 500]`, `[960, 500]` → Merge at `[520, 760]`

#### Sections with >4 nodes
- Wrap within the section: when a row fills 4 nodes, continue on the next row at the section's starting x
- Section background sticky note expands vertically per the bounding-box formula to cover all rows
- Keep max width at 4 nodes wide — expand downward, not rightward

### Triggers — Multiple Allowed

A workflow can have multiple trigger nodes. Use this when:
- The same logic should run on a schedule AND on demand via webhook
- Different entry points feed different parts of the workflow (e.g. hourly sync + real-time webhook)
- Testing: a manual trigger alongside the production schedule trigger

### Other Preferences

- **API calls**: use HTTP Request nodes or the native Pipedrive node (`n8n-nodes-base.pipedrive`) for ALL API calls. Code nodes are for data transformation only — they have NO network access.
- **Pagination**: for Pipedrive list endpoints, prefer the native Pipedrive node with `returnAll: true` (handles pagination automatically). For custom endpoints, use HTTP Request node's built-in pagination or a Loop Over Items approach. See `pipedrive-node-reference.md` for patterns.
- **Switch over IF**: use Switch node (v3) instead of IF node when branching. Switch allows named outputs ("Has Duplicates" / "No Duplicates") which are easier to understand than IF's generic TRUE/FALSE.
- **Timestamps**: persist last-run time via `$getWorkflowStaticData('global')`. Save AFTER a successful API fetch so a failed downstream step causes a safe retry.
- **Item pairing**: use `$('Node Name').all()[$itemIndex].json` inside per-item Code nodes — never `.first()` in loops, never `.item` in Code node JS.
- **Auth**: Pipedrive always uses `httpQueryAuth` (query param `api_token`) for HTTP Request nodes, or `pipedriveApi` credential for native Pipedrive node. Hardcode the token and domain in HTTP Request URLs (see env vars table).

## Error Handling Principles

Every generated workflow must implement this error handling model. It is not optional.

---

### 1. Self-healing first

Before escalating any error, the workflow must attempt to recover on its own:
- Transient failures (timeouts, 429 rate limits, 5xx): retry up to 3× with exponential backoff (2s → 4s → 8s)
- Empty/null API responses: handle gracefully, skip the item, continue the run
- Partial failures in a batch: log the failed item, continue with the rest — never abort the whole run for one bad item

Use `onError: "continueRegularOutput"` on HTTP Request nodes that call external APIs (see concrete JSON in `pipedrive-node-reference.md`). Use the HTTP Request node's built-in retry (`retryOnFail: true`, `maxTries: 3`, `waitBetweenTries: 2000`) for transient failures. Capture errors in a downstream Code node and route via Class A/B Switch node.

---

### 2. Error classification — decide before notifying

Every error that cannot be self-healed must be classified before a notification is sent:

**Class A — AI-resolvable** (no human needed):
- API token expired → can refresh via OAuth or rotate via API
- Rate limit exceeded → can back off and retry later
- Missing field / null value → can infer, default, or skip
- Pipedrive/HubSpot record not found → can search by alternate field
- Stale timestamp / sync gap → can recompute and re-run

**Class B — Human-required** (AI cannot fully resolve):
- Credential revoked / permission removed → human must re-auth
- Schema change in external API (field renamed/removed) → human must update workflow
- Business logic ambiguity (which deal to attach this to?) → human must decide
- External system outage (SharePoint tenant down) → human must wait/escalate
- Data corruption / duplicate records → human must review

---

### 3. Notification format by class

**Class A (AI-resolvable):**
- Send a short personal notification: what failed, that AI is handling it, workflow link
- Immediately attempt the fix via API/MCP
- **Reply in-thread** with the outcome: what went wrong, what approach was taken, and whether it was fixed or escalated to Class B. This creates a clear audit trail and lets the user review AI decisions later.
- Attach a **red sticky note** in the workflow at the failing node — the note contains all technical context (full error, payload, timestamp, what was attempted) that was intentionally omitted from the short message to avoid noise

**Class B (Human-required):**
- Send a full notification: what failed, exact error, why AI cannot fix it, step-by-step remediation guide, relevant links (workflow, external system, docs)
- No separate sticky note needed — the message IS the full context
- Tag the human explicitly

**Red sticky notes — design-time placement:**
Every error-prone node or section gets a red sticky note placed directly above it at build time. Content:
```
## ⚠️ Possible failure: [short name]
**Cause:** what breaks here and why
**Error class:** A (AI can fix) | B (human required)
**If Class A:** what the AI will attempt
**If Class B:** exact manual steps to resolve
**Context fields:** which data fields are relevant for debugging
```
This note is what you see when you land on the workflow from a notification link.

---

### 4. Reaction system (future Slack implementation)

When notifications move to the dedicated personal Slack channel, every error message will support this reaction protocol:

| Reaction | Meaning |
|----------|---------|
| 👀 | AI is currently reviewing / attempting fix |
| 🤖 | Resolved by AI autonomously |
| ✅ | Resolved (by anyone) |
| 👨🏻‍💻 | Resolved by user — user tagged in thread when done |

Each notification must include:
- Whether AI can handle it directly (Class A) or not (Class B)
- A direct deep link to the workflow (`https://your-n8n.domain/workflow/ID`)
- The node name where the failure occurred
- ISO timestamp of failure

**Thread replies (mandatory for Class A):**
When the AI agent resolves a Class A error, it MUST reply in the same notification thread with:
1. What went wrong (error type, affected node, data context)
2. What approach was taken (retry, skip, default, re-route)
3. Whether it succeeded or is being escalated to Class B

This creates an audit trail so the user can review AI decisions asynchronously without disrupting their flow.

This system is not yet implemented. For now, use the notification channel defined in `$env.ERROR_NOTIFICATION_CHANNEL` (placeholder). When the Slack agent is built, this env var will point to it and all existing workflows will route there automatically.

---

### 5. Error handling checklist

All error handling checks are consolidated in the **Mandatory Pre-Output Checklist** above (see "Error Handling" subsection). Concrete JSON patterns for implementing each check are in `pipedrive-node-reference.md` under "Error Handling JSON Patterns".

---

## Global Environment Variables (this user's instance)

| Variable | Value |
|----------|-------|
| `PIPEDRIVE_API_TOKEN` | `YOUR_PIPEDRIVE_API_TOKEN` |
| `PIPEDRIVE_DOMAIN` | `your-company.pipedrive.com` |
| `ERROR_NOTIFICATION_CHANNEL` | Webhook URL for error notifications (placeholder until Slack agent) |
| `N8N_HOST` | `http://your-n8n-host:5678` |
| `N8N_API_KEY` | `YOUR_N8N_API_KEY` |

**In Code nodes, hardcode directly** (not via `$env` — simpler, avoids n8n env var setup):
```js
const TOKEN  = 'YOUR_PIPEDRIVE_API_TOKEN';
const DOMAIN = 'your-company.pipedrive.com';
```

---

## Direct Deployment to n8n (MANDATORY)

**Every time you generate workflow JSON, you MUST deploy it directly to the n8n instance. Do not just output JSON and ask the user to import it manually.**

### Instance Details
- **URL:** `http://your-n8n-host:5678`
- **API Key:** `YOUR_N8N_API_KEY`
- **API Base:** `http://your-n8n-host:5678/api/v1`
- **Auth Header:** `X-N8N-API-KEY: <token>`

### Deployment Flow

After passing the Mandatory Pre-Output Checklist, follow this exact sequence:

#### Step 1 — Check if the n8n MCP tools are available
Check whether `mcp__n8n__create-workflow` is callable. If yes, use the MCP tools (preferred). If not, fall back to `curl` via the Bash tool.

#### Step 2 — Check for existing workflow by name
Before creating, search for a workflow with the same name to avoid duplicates:

**Via MCP:**
Use `mcp__n8n__list-workflows` and check if the name already exists.

**Via curl fallback:**
```bash
curl -s -H "X-N8N-API-KEY: YOUR_N8N_API_KEY" \
  "http://your-n8n-host:5678/api/v1/workflows" | jq '.data[] | select(.name == "YOUR_WORKFLOW_NAME") | .id'
```

#### Step 3a — Create new workflow (no existing match)

**Via MCP:**
Use `mcp__n8n__create-workflow` with the full workflow JSON object.

**Via curl fallback:**
```bash
# Write workflow JSON to a temp file first, then POST it
cat > /tmp/n8n_workflow.json << 'WORKFLOW_EOF'
<PASTE_WORKFLOW_JSON_HERE>
WORKFLOW_EOF

curl -s -X POST \
  -H "X-N8N-API-KEY: YOUR_N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/n8n_workflow.json \
  "http://your-n8n-host:5678/api/v1/workflows"
```

Capture the returned `id` from the response.

#### Step 3b — Update existing workflow (name match found)

**Via MCP:**
Use `mcp__n8n__update-workflow` with the existing workflow ID.

**Via curl fallback:**
```bash
curl -s -X PUT \
  -H "X-N8N-API-KEY: YOUR_N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/n8n_workflow.json \
  "http://your-n8n-host:5678/api/v1/workflows/<WORKFLOW_ID>"
```

#### Step 4 — Activate (if user requested an active workflow)

If the workflow should run on a schedule or respond to webhooks immediately:

**Via MCP:**
Use `mcp__n8n__activate-workflow` with the workflow ID.

**Via curl fallback:**
```bash
curl -s -X POST \
  -H "X-N8N-API-KEY: YOUR_N8N_API_KEY" \
  "http://your-n8n-host:5678/api/v1/workflows/<WORKFLOW_ID>/activate"
```

### Post-Deployment Response

After a successful deployment, always tell the user:
1. ✅ Workflow created/updated: **[Workflow Name]** (ID: `<id>`)
2. Direct link: `http://your-n8n-host:5678/workflow/<id>`
3. Status: Active / Inactive
4. If credentials need to be set manually (no API for credential values), list exactly which nodes need credential assignment in the n8n UI.

### Deployment Error Handling

| Error | Action |
|-------|--------|
| `401 Unauthorized` | API key is invalid — report to user, provide JSON to import manually |
| `400 Bad Request` | Workflow JSON is invalid — fix the JSON and retry once |
| `404 Not Found` | Workflow ID not found for update — fallback to create |
| Network error / timeout | Report to user, provide JSON to import manually as fallback |

If deployment fails after one retry, output the workflow JSON so the user can import it manually, and explain the failure.
