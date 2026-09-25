# The two checks a script cannot run

Every number and event in this file is invented to show the shape of an argument. None is a claim about this repository or anyone in it, and none should be copied into a draft.

Checks 4 and 7 need someone to know whether a claim is true and whether a voice is present. Both resist automation, and both are where prose actually fails. A draft can pass every mechanical check and still say nothing.

## Check 4: the specificity audit

Walk the draft claim by claim. For each one ask: what could a skeptical reader verify?

### The three outcomes

**The claim has a specific.** Keep it.

> `ats-autofill` skips every submit control, and the only click it makes is on an Apply anchor.

A reader can open the source and check.

**The claim has a specific available but does not use it.** Add it.

> Before: The test suite is thorough.
> After: 180 tests, including the two failure paths that caused the April outage.

**The claim has no specific and none exists.** Cut it. Do not soften it into abstraction, and never invent a number.

> Before: Our approach significantly improved developer experience.
> After: (deleted)

The third outcome is the one people avoid, because deleting feels like losing ground. A paragraph that survives only by being unfalsifiable was costing credibility, not adding it.

### Worked example

Draft paragraph:

> The migration was a significant undertaking that required careful coordination across multiple teams. We were able to leverage our existing infrastructure to minimize disruption, and the results speak for themselves.

Claim by claim:

<!-- strip-ai-tells: ignore-start -->
1. "significant undertaking" - no specific. How long? How many people? If unknown, cut.
2. "careful coordination across multiple teams" - how many teams, and what did coordination mean? If it means a shared Slack channel, say that; it is more interesting than the abstraction.
3. "leverage our existing infrastructure" - banned word, and vague. Which infrastructure? Reused how?
4. "minimize disruption" - measurable. What was the downtime?
5. "the results speak for themselves" - they do not. This is the sentence admitting it has no number.
<!-- strip-ai-tells: ignore-end -->

Rewrite, assuming the facts are available:

> The migration took six weeks across three teams, coordinated in one channel and a weekly call. We moved onto the existing Postgres cluster rather than standing up a new one, which held total downtime to eleven minutes.

If those facts are not available, the honest version is two sentences, not five.

### The invention trap

Under pressure to satisfy this check, the temptation is to supply a plausible number. Do not. A fabricated specific is worse than the vague claim it replaced, because it is checkable and wrong. In a cover letter it is a lie to an employer.

When the specific is missing, the options are: find it, or cut the claim. There is no third move.

## Check 7: the author check

Read the finished draft and ask: could anyone have written this, about anything?

### What counts as a voice

Presence of at least one of:

- **A committed position.** Something a reasonable person could disagree with, stated without hedging.
- **An admission.** A limit, a mistake, a thing that did not work.
- **Hard-won knowledge.** A detail that only comes from having done the thing.
- **A judgment call made visible.** Not just what was decided, but the trade that was declined.

### Diagnosis

Symptoms of an absent author:

- Every paragraph is balanced. Nothing is argued, only surveyed.
- No sentence could offend, disappoint, or surprise anyone.
- The draft would be equally true of a competitor.
- Swapping the subject for a different one would require changing almost nothing.

### Worked example

Before:

> Privacy-first AI is an important consideration for healthcare organizations. There are various approaches to protecting sensitive data, each with its own trade-offs. Organizations should carefully evaluate their options.

Nobody wrote this. It surveys and commits to nothing.

After:

> Most healthcare AI ships patient data to someone else's GPU and calls the BAA a privacy story. We run the model on the machine that holds the records instead, which costs us the frontier-scale model and we take that hit deliberately. For records that cannot legally leave the building, it is the right trade.

The second version can be argued with, which is what makes it worth reading. It takes a position, names what the position costs, and does not pretend the cost is zero.

A warning about this example. Filling it in with a real product and a real number is what makes the technique work, and it is also where the invention trap bites hardest. Every specific put into a draft on the writer's behalf must come from the profile, the repo, or the writer's own mouth. The illustration above is deliberately unattributed for that reason: inventing a plausible-sounding cost for a real product would demonstrate the failure this file exists to prevent.

### The repair

When the author is missing, the usual cause is that a hedging pass removed every edge. The repair is to find the sentence the writer actually believes and put it in the first paragraph, unqualified.

A second common cause: the draft reports a decision without its alternative. Naming what was declined, and why, restores the author almost immediately.

## Sequencing

Run the mechanical pass first. It is fast, and clearing the noise makes the judgment passes easier to do honestly.

Then check 4, then check 7, in that order. Specificity before voice, because cutting unverifiable claims often removes the padding that was hiding the absence of a position. Sometimes check 4 deletes half a draft and check 7 then has something to work with.

## Reporting

Say which claims were cut and why. Say when check 7 found a voice already present and needed no change. An audit that always reports changes is performing thoroughness rather than doing it.
