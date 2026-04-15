# Pipedrive + n8n Node Reference

## Authentication

Always use query param auth for Pipedrive — NOT header auth.
Credential type: `httpQueryAuth` — Name: `api_token`, Value: `<token>`

In Code nodes, hardcode the credentials directly (this user's instance):
```js
const TOKEN  = 'YOUR_PIPEDRIVE_API_TOKEN';
const DOMAIN = 'your-company.pipedrive.com';
```

Base URL pattern: `https://${DOMAIN}/api/v1/<endpoint>?api_token=${TOKEN}`

---

## Key Endpoints & Response Shapes

### GET /recents
```
?since_timestamp=YYYY-MM-DD HH:MM:SS
&items=activity,note,file,deal,person,organization
&start=0&limit=500
```
Response:
```json
{
  "success": true,
  "data": [{ "item_type": "activity", "data": { ... } }],
  "additional_data": {
    "pagination": {
      "start": 0, "limit": 500,
      "more_items_in_collection": true,
      "next_start": 500
    }
  }
}
```

### POST /files (upload binary to entity)
```
multipart/form-data
  file        → binary blob
  deal_id     → number   (or person_id / org_id)
```

### POST /notes
```json
{ "content": "string", "deal_id": 123 }
```
Also accepts: `person_id`, `org_id`, `lead_id`

### POST /activities
```json
{
  "subject": "string",
  "type": "call|meeting|task|...",
  "due_date": "YYYY-MM-DD",
  "deal_id": 123
}
```

### GET /deals, /persons, /organizations
```
?start=0&limit=500&status=open
```
All list endpoints share the same pagination shape as /recents.

---

## API Call Patterns

### Rule: Code Nodes = Data Transformation ONLY

n8n Code nodes have **NO network access**. `fetch`, `axios`, `http`, `https`, `XMLHttpRequest` — all throw `ReferenceError`.

- **API calls** → HTTP Request node or native Pipedrive node
- **Data transformation** → Code node

### Native Pipedrive Node (Preferred for Standard Operations)

For standard CRUD, use `n8n-nodes-base.pipedrive`. It handles pagination automatically with `returnAll: true`.

**Resources:** `person`, `deal`, `organization`, `activity`, `note`, `lead`, `product`, `file`
**Operations:** `create`, `delete`, `get`, `getAll`, `search`, `update`

```json
{
  "parameters": {
    "resource": "person",
    "operation": "getAll",
    "returnAll": true
  },
  "type": "n8n-nodes-base.pipedrive",
  "typeVersion": 1,
  "position": [300, 500],
  "id": "unique-id",
  "name": "Get All Persons",
  "credentials": {
    "pipedriveApi": {
      "id": "REPLACE_WITH_PIPEDRIVE_CREDENTIAL_ID",
      "name": "Pipedrive account"
    }
  }
}
```

**When to use:** getting all persons, deals, organizations, activities, notes — any standard list/CRUD operation.

### HTTP Request Node (For Custom/Unsupported Endpoints)

For endpoints not covered by the native node (e.g., `/recents`, `/persons/merge`, custom field endpoints), use HTTP Request with query param auth.

```json
{
  "parameters": {
    "url": "https://your-company.pipedrive.com/api/v1/recents",
    "authentication": "predefinedCredentialType",
    "nodeCredentialType": "httpQueryAuth",
    "sendQuery": true,
    "queryParameters": {
      "parameters": [
        { "name": "since_timestamp", "value": "={{ $json.sinceTimestamp }}" },
        { "name": "items", "value": "activity,note,file" },
        { "name": "limit", "value": "500" }
      ]
    },
    "options": {}
  },
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.4,
  "position": [520, 500],
  "id": "unique-id",
  "name": "Fetch Recents",
  "credentials": {
    "httpQueryAuth": {
      "id": "REPLACE_WITH_CREDENTIAL_ID",
      "name": "Pipedrive API Token"
    }
  },
  "retryOnFail": true,
  "maxTries": 3,
  "waitBetweenTries": 2000,
  "onError": "continueRegularOutput"
}
```

### HTTP Request Pagination (Loop Pattern)

For paginated custom endpoints, use a **Loop Over Items** node or process the `more_items_in_collection` flag in a Code node that reads the HTTP response (no network calls — just check the pagination metadata and set `start` for the next iteration).

**Simple approach (most cases):** set `limit=500` on the HTTP Request. If <500 records expected, one call is enough.

**Full pagination approach:** use a workflow loop:
1. HTTP Request node fetches one page (limit=500, start from variable)
2. Code node checks `$json.additional_data.pagination.more_items_in_collection` — if false, stop loop
3. Code node extracts `next_start` and passes it back to the HTTP Request node via loop

### Helper: toQS (for Code node URL building)

When building query strings inside Code nodes (for non-network purposes like generating URLs for display/logging):

```js
function toQS(obj) {
  return Object.entries(obj)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}
```

**Do NOT use `new URLSearchParams()`** — not available in n8n sandbox.

---

## Code Node: Item Access Patterns

These are the most common source of broken workflows. Use exactly these patterns.

### Current item
```js
$json.fieldName          // current item's JSON field
$binary.data             // current item's binary (after HTTP download)
$itemIndex               // position of current item in the batch (0-based)
```

### Reference another node's data — single item flow
```js
$('Node Name').first().json.field   // OK only when you know there is exactly 1 item
```

### Reference another node's data — multi-item flow (loops, batches)
```js
// CORRECT — pairs by index
const ctx = $('Node Name').all()[$itemIndex].json;

// WRONG — always returns item 0
const ctx = $('Node Name').first().json;

// WRONG — .item is expression-only, throws in Code nodes
const ctx = $('Node Name').item.json;
```

### Merge upstream context into driveItem (standard SharePoint pattern)
```js
// Add this as a Code node immediately after any HTTP Request that replaces $json
// so downstream nodes can access both the API response AND original metadata
const ctx      = $('Encode SP URL').all()[$itemIndex].json;  // original metadata
const response = $json;                                       // current node's response

return [{
  json: {
    ...response,
    entityType:  ctx.entityType,
    entityId:    ctx.entityId,
    spUrl:       ctx.spUrl
  }
}];
```

---

## n8n Node Type → Use Case Mapping

| Use Case | Node Type | typeVersion |
|----------|-----------|-------------|
| Hourly/daily schedule | `n8n-nodes-base.scheduleTrigger` | 1.2 |
| Webhook receiver | `n8n-nodes-base.webhook` | 2.1 |
| Any API call | `n8n-nodes-base.httpRequest` | 4.4 |
| Custom JS logic | `n8n-nodes-base.code` | 2 |
| Branch on condition | `n8n-nodes-base.if` | 2.2 |
| Route to N branches | `n8n-nodes-base.switch` | 3.2 |
| Pipedrive CRUD (preferred) | `n8n-nodes-base.pipedrive` | 1 |
| Split array field out | `n8n-nodes-base.splitOut` | 1 |
| Combine branches | `n8n-nodes-base.merge` | 3.1 |
| Set / rename fields | `n8n-nodes-base.set` | 3.4 |
| Filter items | `n8n-nodes-base.filter` | 2 |
| Aggregate items | `n8n-nodes-base.aggregate` | 1 |
| Remove duplicates | `n8n-nodes-base.removeDuplicates` | 1 |
| Documentation | `n8n-nodes-base.stickyNote` | 1 |
| Stop with error | `n8n-nodes-base.stopAndError` | 1 |

---

## Expression Syntax

| What | Expression |
|------|-----------|
| Current item field | `={{ $json.fieldName }}` |
| Named node output | `={{ $('Node Name').first().json.field }}` |
| Paired item from named node | `={{ $('Node Name').item.json.field }}` |
| All items from named node | `={{ $('Node Name').all() }}` |
| Env variable | `={{ $env.VAR_NAME }}` |
| Workflow static data | Only in Code nodes: `$getWorkflowStaticData('global')` |
| Binary from current item | `$binary.data` (Code node) |

**Important**: `$('Node Name').item` respects item pairing (correct for loops).
`$('Node Name').first()` always returns item 0 (wrong in loops).

---

## IF Node Condition Operators (typeVersion 2)

```json
{ "type": "string",  "operation": "equals" }
{ "type": "string",  "operation": "contains" }
{ "type": "number",  "operation": "gt" }
{ "type": "boolean", "operation": "equals" }
{ "type": "object",  "operation": "exists",  "singleValue": true }
{ "type": "object",  "operation": "notExists","singleValue": true }
{ "type": "array",   "operation": "notEmpty", "singleValue": true }
```

---

## Microsoft Graph API (SharePoint)

Resolve a sharing URL to a driveItem:
```
GET https://graph.microsoft.com/v1.0/shares/{encodedUrl}/driveItem
```
Encode: `'u!' + base64url(spUrl)` (no padding, `+→-`, `/→_`)

driveItem has `file` facet if it's a file (not a folder).
`driveItem['@microsoft.graph.downloadUrl']` — pre-auth SAS URL, no extra headers needed, expires in ~1hr.

Credential: OAuth2, scope `https://graph.microsoft.com/Files.Read.All offline_access`

---

## Known Broken Patterns (Never Use)

Check every Code node against this list before outputting workflow JSON. These cause silent failures, incorrect data, or runtime errors.

| Pattern | Why It Breaks | Use Instead |
|---------|--------------|-------------|
| `$json` after Merge without branch check | Merge combines items from multiple branches — `$json` could be from either, order not guaranteed | Tag items with a `_branch` field in a Set node before the Merge, then filter/check after |
| `new Date()` for timestamps | Uses server timezone, not workflow timezone — off-by-hours bugs | `$now` (respects `GENERIC_TIMEZONE`) or `DateTime.now().setZone('explicit/zone')` |
| `$input.all()` assuming order after Merge | Merge does not guarantee item order across branches | Sort explicitly after Merge, or tag items with sequence numbers before branching |
| `new URLSearchParams(...)` | **Not available** in n8n's Code node sandbox — throws `ReferenceError: URLSearchParams is not defined` | Use `toQS()` helper: `Object.entries(obj).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&')` |
| String concatenation to build URLs (without encoding) | Breaks on special characters, spaces, unicode in parameter values | Use the `toQS()` helper above, or `encodeURIComponent()` per param |
| `JSON.stringify` on raw n8n item object | n8n items have circular references (`$node`, `$workflow`) — throws TypeError | Stringify only `$json` fields: `JSON.stringify({ f: $json.field })` |
| `await` inside `.map()` | `.map()` returns Promise array, doesn't await them — fires concurrently, results lost | `for (const item of items) { await ... }` or `await Promise.all(items.map(async ...))` |
| Returning `undefined` / nothing from Code node | n8n expects an array of items — returning nothing silently stops downstream | Always `return [{ json: { ... } }]` — for empty results: `[{ json: { empty: true } }]` |
| `console.log()` in production Code nodes | Goes to server stdout only — invisible in n8n UI, no context | Use a Set node field or `$execution.id` in structured output |
| `.item` in Code node JS | Expression-only syntax — throws runtime error in Code node | `$('Node Name').all()[$itemIndex].json` |
| `.first()` inside loop/batch | Always returns item 0 regardless of iteration — wrong for multi-item | `$('Node Name').all()[$itemIndex].json` |
| `$getWorkflowStaticData` outside Code node | Only available in Code node JS — expressions can't call it | Move to a Code node, pass result downstream via `$json` |
| `fetch()` in Code node | **Not available** in n8n's sandbox — throws `ReferenceError: fetch is not defined` | Use HTTP Request node for ALL API calls. Code nodes are for data transformation only |
| `axios` / `http` / `https` in Code node | Node.js built-in modules not available in n8n sandbox | Use HTTP Request node |
| Any HTTP call in a Code node | n8n sandbox blocks all network access — `fetch`, `XMLHttpRequest`, `axios`, `http.get` all fail | Move the API call to an HTTP Request node, pass data to Code node via `$json` |

---

## Error Handling JSON Patterns

Concrete n8n node configurations for the error handling model in SKILL.md. Copy these patterns directly into generated workflows.

### continueOnFail — HTTP Request Node

Set `onError` on any HTTP Request node calling an external API. This captures errors as data instead of stopping the workflow.

```json
{
  "parameters": {
    "method": "GET",
    "url": "={{ $json.apiUrl }}",
    "authentication": "predefinedCredentialType",
    "nodeCredentialType": "httpQueryAuth",
    "options": {}
  },
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.4,
  "position": [520, 400],
  "id": "unique-id-here",
  "name": "Fetch External Data",
  "credentials": {
    "httpQueryAuth": {
      "id": "REPLACE_WITH_CREDENTIAL_ID",
      "name": "Pipedrive API Token"
    }
  },
  "onError": "continueRegularOutput"
}
```

**`onError` values:**

| Value | Behavior |
|-------|----------|
| `"stopWorkflow"` | Default — workflow halts on error |
| `"continueRegularOutput"` | Error data flows through regular output as `$json.error`, `$json.statusCode`, `$json.message` |
| `"continueErrorOutput"` | Error data routes to a separate error output pin |

### Capturing Errors After continueOnFail

In a Code node immediately after an HTTP Request with `onError: "continueRegularOutput"`:

```js
// After continueOnFail, failed requests produce these fields:
//   $json.error       → true (boolean, present only on failure)
//   $json.statusCode  → HTTP status code (429, 500, 401, etc.)
//   $json.message     → Error message string
//   $json.cause       → Original error details (object)

const isError = $json.error === true;
const statusCode = $json.statusCode || 0;
const errorMessage = $json.message || '';

if (isError) {
  const isTransient = [429, 500, 502, 503, 504].includes(statusCode);
  const isAuth = [401, 403].includes(statusCode);

  return [{
    json: {
      hasError: true,
      errorClass: isAuth ? 'B' : (isTransient ? 'A' : 'B'),
      statusCode,
      errorMessage,
      aiCanFix: !isAuth,
      originalPayload: $json
    }
  }];
}

// No error — pass data through
return [{ json: { hasError: false, ...$json } }];
```

### Class A / Class B Switch Node

Place after the error classifier Code node. Named outputs for clear routing.

```json
{
  "parameters": {
    "rules": {
      "values": [
        {
          "outputKey": "Class A - AI Can Fix",
          "conditions": {
            "options": { "caseSensitive": true, "leftValue": "" },
            "conditions": [
              {
                "leftValue": "={{ $json.errorClass }}",
                "rightValue": "A",
                "operator": { "type": "string", "operation": "equals" }
              }
            ],
            "combinator": "and"
          }
        },
        {
          "outputKey": "Class B - Human Required",
          "conditions": {
            "options": { "caseSensitive": true, "leftValue": "" },
            "conditions": [
              {
                "leftValue": "={{ $json.errorClass }}",
                "rightValue": "B",
                "operator": { "type": "string", "operation": "equals" }
              }
            ],
            "combinator": "and"
          }
        }
      ]
    },
    "options": {}
  },
  "type": "n8n-nodes-base.switch",
  "typeVersion": 3.2,
  "position": [960, 400],
  "id": "unique-id-here",
  "name": "Error Class?"
}
```

**Connections:** "Class A - AI Can Fix" output → self-healing branch. "Class B - Human Required" output → human notification branch.

### Self-Healing Retry Pattern (HTTP Request Node)

Retries are handled by the HTTP Request node's built-in retry mechanism — NOT by Code nodes (which have no network access).

Set these properties on any HTTP Request node that may encounter transient errors:

```json
{
  "retryOnFail": true,
  "maxTries": 3,
  "waitBetweenTries": 2000
}
```

This retries on HTTP errors (429, 5xx) with a fixed delay. n8n handles the retry loop internally.

If the node still fails after all retries AND has `onError: "continueRegularOutput"`, the error data flows to the next node as `$json.error`, `$json.statusCode`, `$json.message` — where a Code node can classify it (Class A/B) without making any network calls.

**Flow:**
```
HTTP Request (retryOnFail:3, onError:continueRegularOutput)
  → Code: Classify Error (data transform only — no network)
  → Switch: "Class A" / "Class B"
  → Class A: send notification + AI thread reply with approach
  → Class B: send full notification with remediation steps
```

### Notification Payload Template

Build this in a Code node or Set node before the notification HTTP Request. Send to `$env.ERROR_NOTIFICATION_CHANNEL`.

```json
{
  "workflow_name": "={{ $workflow.name }}",
  "workflow_id": "={{ $workflow.id }}",
  "workflow_url": "={{ $env.N8N_HOST }}/workflow/{{ $workflow.id }}",
  "node_name": "Fetch External Data",
  "error_class": "={{ $json.errorClass }}",
  "error_message": "={{ $json.errorMessage }}",
  "status_code": "={{ $json.statusCode }}",
  "ai_can_fix": "={{ $json.aiCanFix }}",
  "fix_attempted": true,
  "retry_success": "={{ $json.retrySuccess }}",
  "timestamp": "={{ $now.toISO() }}",
  "execution_id": "={{ $execution.id }}",
  "execution_url": "={{ $env.N8N_HOST }}/execution/{{ $execution.id }}",
  "remediation_steps": "Class B only — replace with specific fix instructions"
}
```

For **Class A resolved** notifications: omit `remediation_steps`, set `fix_attempted: true`. The AI agent must **reply in the same thread** with:
- What went wrong (error details)
- What approach was taken to fix it
- Whether it succeeded or is being escalated to Class B

For **Class B** notifications: populate `remediation_steps` with exact human steps.
