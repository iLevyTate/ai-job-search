---
name: ats-autofill
description: >
  Prefills US job application forms (Greenhouse, Lever, Ashby, Workday, and generic forms)
  from a local profile, attaches the tailored resume and cover letter, screenshots the result,
  and can press the employer's Submit button when you ask it to. LinkedIn, Indeed, and Dice stay manual.
  Triggers on: autofill, fill application, apply to job, /autofill
---

# ATS Autofill

Fills out a job application form. You check it, then either send it yourself or tell the tool to press Submit.

## Sending the application

Nothing is sent until you say so. In Desk, **Submit for me** presses the employer's Submit button. In a terminal, type `submit` and press Enter. Enter alone closes the browser without sending.

LinkedIn, Indeed, and Dice are the exception. Their terms forbid automated submission, so those three never get a Submit for me button. You click their button yourself.

Check work authorization, sponsorship, and compensation before you send. Those answers are attested statements.

## Setup

```bash
cd .agents/skills/ats-autofill/cli
bun install
bunx playwright install chromium
```

Then copy the profile template and fill it in:

```bash
cp application_profile.example.json application_profile.json
```

`application_profile.json` is gitignored. It holds contact details and work-authorization answers, so it never gets committed.

Verify the setup:

```bash
cd .agents/skills/ats-autofill/cli && node --experimental-strip-types src/cli.ts doctor
```

## Usage

**Inspect first.** See what would be filled without touching the page:

```bash
bun run src/cli.ts inspect https://job-boards.greenhouse.io/acme/jobs/1234567
```

**Then fill, with the browser visible:**

```bash
bun run src/cli.ts fill https://job-boards.greenhouse.io/acme/jobs/1234567 --headed \
  --resume ../../../../cv/main_acme.pdf \
  --cover ../../../../cover_letters/cover_acme_ai_engineer.pdf
```

With `--headed`, the browser opens, the form fills, and a review gate waits. Review every field, then either send it yourself in the browser or tell the gate to send it. In a direct CLI session, type `submit` to send, or press Enter to close without sending; anything else you type is treated as Enter, and a closed stdin cancels. When Desk launched Autofill, the review card offers Continue, Cancel, and Submit for me.

## How it decides what to fill

`src/matcher.ts` holds pure, unit-tested matching logic (`bun test`). For each form field it derives a label (aria-label, `<label for>`, ancestor label, fieldset legend, placeholder, name) and matches it against the profile.

Three behaviors worth knowing:

- **Sponsorship polarity is resolved explicitly.** "Do you require sponsorship?" and "Are you authorized to work without sponsorship?" get opposite answers from the same profile data. This is the single most dangerous class of field to auto-answer, so it is handled by a dedicated resolver with its own tests rather than by a generic keyword rule.
- **Compensation is never volunteered.** `desiredSalary` and `currentSalary` default to null and stay blank. A blank box is a better negotiating position than a number typed before you knew the range. Set the value in the profile if you want it filled, and it will be flagged for review.
- **Low confidence means unfilled.** When no rule matches confidently, the field is left alone and listed under NEEDS YOUR INPUT. The tool never invents a plausible answer to a question it does not understand.

Fields marked `<-- CHECK` in the output were filled from heuristic rules. Read those before submitting.

## What it does not do

- Does not submit unless a person answers the review gate with Submit. No flag, environment variable or batch mode answers it for them, and LinkedIn, Indeed and Dice are refused by hostname
- Does not create accounts or log in. Log in yourself first if the portal requires it, or use `--headed` and authenticate in the open browser.
- Does not defeat CAPTCHAs or bot detection. If a portal blocks automation, fill that one by hand.
- Does not answer essay questions ("Why do you want to work here?"). Those come from `/apply`, which writes them against the actual posting.

## Coverage

| ATS | Detection | Notes |
|-----|-----------|-------|
| Greenhouse | URL | Best coverage. Standard labels, native file inputs. |
| Lever | URL | Good coverage. |
| Ashby | URL | Good coverage. Some custom React widgets are skipped and reported. |
| Workday | URL | Partial. Multi-step wizards need manual navigation between steps; re-run per step. |
| Generic / company-hosted | fallback | Works when labels are semantic. Reports whatever it cannot map. |

LinkedIn Easy Apply, Indeed, and Dice are deliberately unsupported for filling. Use them to find the posting, then apply on the employer's own ATS link where one exists.
