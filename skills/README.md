# GTM Skills

Custom [Claude Code skill](https://docs.anthropic.com/claude/docs/skills) files that encode reusable patterns for GTM engineering work. Drop any of these into `~/.claude/skills/` (or symlink them) and Claude will load them automatically based on the `description` trigger in the SKILL.md frontmatter.

## Skills in this directory

| Skill | Triggers on | What it covers |
|-------|-------------|----------------|
| **`n8n/`** | n8n workflow questions, JSON generation, self-hosting, Clay+n8n, CRM automation | Orchestrator skill with 6 sub-skills (workflow-design, triggers-webhooks, error-handling, clay-integration, crm-automation, self-hosting). Includes full Pipedrive + Microsoft Graph node reference and a mandatory pre-output checklist for every generated workflow JSON. |
| **`clay/`** | Clay table design, enrichment waterfalls, credit economics | When to use Clay vs n8n, credit-efficient waterfall ordering, table-to-outbound handoff patterns. |
| **`cold-email/`** | Cold email writing, sequences, deliverability, domain warmup | Copywriting frameworks, sequence architecture, deliverability tuning. |
| **`list-building/`** | Lead list building, Sales Navigator search, ICP matrices | Boolean search patterns, ICP tiering, list QA. |
| **`signal-sourcer/`** | Buying signals, intent data, signal scoring, trigger mapping | How to detect, score, and route signals into outbound. |
| **`linkedin-ads/`** | LinkedIn advertising, campaign setup, targeting, bid strategy | B2B LinkedIn Ads playbook. |
| **`linkedin-content/`** | LinkedIn organic posting, algorithm, content frameworks | Organic content strategy for founders and GTM leaders. |
| **`gtm-philosophy/`** | GTM strategy, multi-channel coordination, outbound fundamentals | Core principles that inform every other skill here. |
| **`personalization-playbooks/`** | Personalization level per outreach category | Inbound / Postbound / Bridgebound / Outbound personalization playbooks. |

## How the skills are structured

Each skill is a folder with:
- `SKILL.md` — frontmatter (name, description, triggers) + the skill body
- `resources/` — reference files loaded on demand via Glob + Read
- (n8n only) nested sub-skills under `.claude/skills/` for topic-specific deep dives

The `n8n` skill in particular is an **orchestrator pattern** — the top-level SKILL.md routes to sub-skills based on the question type, then each sub-skill loads its own references. This keeps the context window tight while still giving Claude access to hundreds of pages of reference material when needed.

## Why these exist

GTM engineering is glue work. Every client uses slightly different tools, every workflow has slightly different edge cases, and the same patterns (error handling, webhook design, waterfall enrichment, sequence timing) come up again and again. Encoding them as skills means Claude gets the same playbook I'd use without me having to retype it for every project.

## Installation

```bash
# Option 1: symlink into your Claude Code skills dir
ln -s "$(pwd)/n8n" ~/.claude/skills/n8n
ln -s "$(pwd)/cold-email" ~/.claude/skills/cold-email
# …etc

# Option 2: copy
cp -R n8n ~/.claude/skills/
```

Restart Claude Code. The skills will auto-load based on their trigger descriptions.
