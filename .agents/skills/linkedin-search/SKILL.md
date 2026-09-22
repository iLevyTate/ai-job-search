---
name: linkedin-search
version: 1.0.0
description: >
  Off unless the user has set enabled: true in this file. LinkedIn's User
  Agreement prohibits scraping, so /scrape skips this portal by default. Invoke
  only after the user turns it on and accepts that automated access is against
  LinkedIn's terms and is their own risk. Do not enable it for them.
context: fork
enabled: false  # Off by default. Set true only if you accept LinkedIn's terms risk yourself.
allowed-tools: Bash(bun run .agents/skills/linkedin-search/cli/src/cli.ts *)
---

# LinkedIn Search Skill

Search live job listings from LinkedIn's public job board for **any country/region**
(and remote). No authentication, no API key, and **zero runtime dependencies** — it runs
with just `bun`. The location is always passed explicitly, so the same skill works for a
forker in any market out of the box.

> This is a country-agnostic worked example of the repo's job-portal-skill pattern.
> LinkedIn's `jobs-guest` endpoints are global and the HTML parsing is country-independent;
> only the `--location` you pass changes per market.

## ⚠️ Off by default. Your risk if you turn it on

LinkedIn's User Agreement prohibits scraping and other automated access.
`/scrape` skips this portal while `enabled` above is `false`.

To turn it on, set `enabled: true` in this file yourself. That choice is yours:
the Desk will not flip it for you, and a release build leaves it off. Keep the
volume low. Do not use it commercially or to collect listings in bulk.

## When to use this skill

- Search for job openings in a given location (any country/city) or remotely
- Filter by recency (posted today / last 7 / 14 / 30 days) or workplace type (remote/hybrid/onsite)
- Get the full description of a specific job listing

## Commands

### Search job listings

```bash
bun run .agents/skills/linkedin-search/cli/src/cli.ts search --location "<place>" [flags]
```

Key flags:
- `--location <text>` / `-l <text>` — **required.** A LinkedIn place string, e.g. `"Mumbai, Maharashtra, India"`, `"Berlin, Germany"`, `"London, United Kingdom"`, or `"Remote"`.
- `--query <text>` / `-q <text>` — keyword search (title, skill, role). Recommended.
- `--jobage <days>` — posted within N days: `1`, `7`, `14`, `30`. Omit for all postings.
- `--jobage-minutes <n>` — posted within N minutes (sub-day precision, e.g. `30`). Conflicts with `--jobage` — pass only one.
- `--remote <mode>` — `remote`, `hybrid`, or `onsite` (workplace-type filter).
- `--page <n>` — page number (1-indexed, 10 results per page).
- `--limit <n>` / `-n <n>` — cap total results emitted (client-side).
- `--format json|table|plain` — default `json`.

### Fetch full job detail

```bash
bun run .agents/skills/linkedin-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

`id` is the job ID from `search` results (e.g. `4426311357`). You may also pass a full
LinkedIn `jobs/view/...` URL or a `urn:li:jobPosting:...` URN. Returns the full description,
seniority, employment type, job function, and industries.

## Usage examples

```bash
# Data engineer roles in Bengaluru, last 30 days
bun run .agents/skills/linkedin-search/cli/src/cli.ts search -q "data engineer" -l "Bengaluru, Karnataka, India" --jobage 30 --format table

# Product manager roles in Berlin, remote
bun run .agents/skills/linkedin-search/cli/src/cli.ts search -q "product manager" -l "Berlin, Germany" --remote remote --format table

# Any role, fully remote
bun run .agents/skills/linkedin-search/cli/src/cli.ts search -q "paralegal" -l "Remote" --format table

# Engineer roles, remote, posted in the last 30 minutes
bun run .agents/skills/linkedin-search/cli/src/cli.ts search -q "engineer" -l "Remote" --jobage-minutes 30 --format table

# Full details for a specific job
bun run .agents/skills/linkedin-search/cli/src/cli.ts detail 4426311357 --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — programmatic use, passing IDs to `detail` |
| `table` | Quick human-readable scanning |
| `plain` | Reading a single job's full detail (`detail` command) |

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` and the process exits with code `1`.

## Notes

- Data is from LinkedIn's public `jobs-guest` endpoints — no credentials required.
- Page size is fixed at 10 results per page.
- LinkedIn may rate-limit; the CLI retries 429/5xx with exponential backoff. Keep volume low (see ToS note above).
- Job IDs are numeric (e.g. `4426311357`) — pass them as-is to `detail`.
