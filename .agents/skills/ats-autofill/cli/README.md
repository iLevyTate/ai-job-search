# ats-autofill CLI

Prefills US job application forms from `application_profile.json`. **Never submits.**

## Install

```bash
bun install
bunx playwright install chromium
node --experimental-strip-types src/cli.ts doctor
```

`doctor` checks Playwright, the browser, and the profile file, and exits non-zero if anything is missing.

## Commands

| Command | Purpose |
|---------|---------|
| `fill <url>` | Fill the form and stop before submitting. Needs `--headed` (or `--dry-run`) |
| `inspect <url>` | List fields and what each would be filled with (no page interaction) |
| `doctor` | Verify install and profile |

## Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--profile, -p` | `<repo root>/application_profile.json` | Profile path. Must be a `.json` file inside the repo. |
| `--resume, -r` | profile value | Resume to attach. A flag path is relative to the current directory. A path stored in the profile is relative to the repo root. Either way it must resolve inside the repo. |
| `--cover, -c` | profile value | Cover letter to attach. Same path rule as `--resume`. |
| `--screenshot, -o` | `job_scraper/autofill_<ts>.png` | Screenshot destination |
| `--headed` | off | Show the browser and pause at the review gate. Required for `fill`: without it there is no review, so a headless `fill` is refused unless `--dry-run` is given. |
| `--dry-run` | off | Report without filling |
| `--timeout` | `30000` | Navigation timeout in ms |
| `--format` | `json` (`table` for `inspect`) | Output format |

## Paths

`--profile`, `--resume`, `--cover`, and the document paths stored in the profile are resolved through `realpath` and refused when they land outside the repo root (the folder holding `CLAUDE.md`) or lack a document extension (`.pdf`, `.docx`, `.doc`, `.txt`, `.md`, `.rtf`, `.odt`; `.json` for the profile). A symlink inside the repo that points out of it is refused too. The browser's file input attaches whatever path it is handed, so this is what keeps a form from receiving a key file, the tracker, or `.env`.

Headed review uses `StdinReviewGate` (Enter continues, stdin close cancels) unless Desk set `JOB_SEARCH_DESK_REVIEW_URL`. Then `DeskReviewGate` posts browser-ready and waits for Continue or Cancel. Neither adapter can submit.

## Exit codes

`0` success. `1` with a JSON error object on stderr for: `NO_URL`, `BAD_URL`, `HEADLESS_FILL`, `BAD_PROFILE`, `BAD_DOCUMENT`, `OUTSIDE_WORKSPACE`, `MISSING_DOCUMENT`, `BAD_ARG`, `BAD_CMD`, `FILL_FAILED`.

## Tests

```bash
bun test        # matching logic, offline, no browser needed
bun run typecheck
```

The tests cover work-authorization polarity, identity mapping, rule precedence, the never-volunteer-salary rule, decline-to-self-identify option matching across vendor phrasings, document confinement, and the headless-fill refusal. Add a case here before changing `src/matcher.ts` or `src/documents.ts`.
