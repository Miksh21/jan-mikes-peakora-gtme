# n8n MCP Server

Custom [Model Context Protocol](https://modelcontextprotocol.io/) server that gives Claude full programmatic control over a self-hosted n8n instance. Built so a GTM engineer can design, deploy, and manage n8n workflows in plain English from inside Claude Code — no clicking around the n8n UI.

## What it does

Exposes the n8n REST API as MCP tools:

- **Workflows** — list, get, create, update, delete, activate, deactivate, run
- **Executions** — list, get, delete
- **Credentials** — list, create, update, delete, fetch schema
- **Variables** — list, create, update, delete (typed: string/number/boolean/secret)
- **Tags, users, webhooks, community nodes, source control, audit**

Built with `@modelcontextprotocol/sdk` and `zod` for strict input validation on every tool.

## Transports

| Mode    | Use case                                              |
|---------|-------------------------------------------------------|
| `stdio` | Local dev — Claude Desktop launches it as a subprocess |
| `sse`   | Remote — Docker / DigitalOcean App Platform           |

When running in SSE mode, the server optionally exposes an OAuth2 flow (authorization code + refresh token) so Claude can authenticate via email/password through a browser. JWT access tokens are signed with an `OAUTH_JWT_SECRET`. Disable auth by leaving OAuth env vars blank.

## Deployment

Designed to run on a small DigitalOcean App Platform instance (`basic-xxs`) in the Frankfurt region so prospect data stays in the EU — a hard requirement for DACH enterprise clients I've built this for.

`app-spec.yaml` is ready to deploy via `doctl apps create --spec app-spec.yaml`. All secrets are declared as `scope: RUN_TIME, type: SECRET` — nothing is baked into the image.

### Docker / docker-compose

```bash
cp .env.example .env
# fill in N8N_BASE_URL and N8N_API_KEY
docker compose up -d
```

Health check: `GET /health`.

## Environment

See [`.env.example`](./.env.example). Required:

- `N8N_BASE_URL` — your n8n instance root URL
- `N8N_API_KEY` — generate from `Settings → API` in n8n

Optional (OAuth): `OAUTH_USER_EMAIL`, `OAUTH_USER_PASSWORD`, `OAUTH_JWT_SECRET`, `OAUTH_BASE_URL`.

## Architecture notes

- **Thin wrapper, not a reimplementation.** All requests proxy straight to the n8n REST API — no state, no caching, no database. This keeps the surface area auditable and upgrades trivial.
- **Zod schemas everywhere.** Every tool validates its input before touching the network. Malformed LLM tool calls fail fast with clear errors instead of half-completing.
- **OAuth is opt-in.** For local stdio use you don't need it. For a public SSE deployment you do. Either way, no credentials are ever logged.

## Connecting from Claude

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "n8n": {
      "command": "node",
      "args": ["/path/to/n8n-mcp-server/build/index.js"],
      "env": {
        "N8N_BASE_URL": "https://your-n8n-instance.example.com",
        "N8N_API_KEY": "your-n8n-api-key"
      }
    }
  }
}
```

For remote SSE deployments, use the `sse` transport URL in your MCP client config instead.

## License

MIT — see root [`LICENSE`](../LICENSE).
