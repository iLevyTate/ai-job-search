---
name: strip-ai-tells
description: This skill should be used when the user asks to "strip AI tells", "run STRIP-AI-TELLS", "does this sound AI", "make this sound human", "audit this draft", "final pass on this", "check this before I send it", or asks whether prose reads as machine-written. Applies to any polished prose before delivery - cover letters, LinkedIn posts, articles, emails, README copy, PR descriptions. Runs as a separate audit pass after drafting, never during it.
---

# STRIP-AI-TELLS

A self-audit run on finished prose to catch the patterns that mark it as machine-written. This is an editing pass, not a writing guide. It runs on a draft that already exists.

## The two-pass rule

Generate first. Audit second. Never both at once.

Writing while auditing produces prose that is cautious rather than good, because every sentence gets second-guessed as it lands. Draft freely, then switch roles and attack the result. For anything that matters, put real separation between the passes.

When asked to write something and strip the tells, produce the draft, then state plainly that the audit pass is starting, then run it.

## Running the mechanical checks first

```bash
python .claude/skills/strip-ai-tells/scripts/audit_prose.py DRAFT.md
python .claude/skills/strip-ai-tells/scripts/audit_prose.py DRAFT.md --format json
cat draft.md | python .claude/skills/strip-ai-tells/scripts/audit_prose.py -
```

Exit status is 1 when anything is flagged and 0 when nothing is, so the call can gate a delivery step. The script is standard library only. Before any check runs it masks code in every form, URLs and link targets, YAML frontmatter, markdown table separators, and blockquotes, because quoted material belongs to whoever said it. To exempt a region that must show bad prose in order to teach it, wrap it in `<!-- strip-ai-tells: ignore-start -->` and `<!-- strip-ai-tells: ignore-end -->`.

Output separates two severities, and the split carries the whole design:

- **FIX** is a mechanical certainty. An em dash is an em dash. Correct it.
- **LOOK** is a heuristic that cannot read the sentence. It marks a place to inspect. Some of these fire on good prose and should be dismissed after a look.

Never treat a LOOK hit as an instruction. Read the line and decide.

The word list lives in `scripts/bans.txt`, one case-insensitive regex per line with `#` comments. Nothing is hardcoded in the script, so tune the list rather than editing code.

## The seven checks

Checks 1, 2, 3, 5, and 6 are mechanized. Checks 4 and 7 are not, and they are the two that matter most.

### 1. Rhythm

No three consecutive sentences of the same length. Put a 34-word sentence next to a 5-word one. The script flags two shapes: three sentences in a row landing in the 15-to-20-word band, and three in a row whose counts sit within two words of each other. Fix by breaking one or fusing two, not by padding.

### 2. Structural bans

Each of these is caught mechanically:

<!-- strip-ai-tells: ignore-start -->
- Em dashes and en dashes, including LaTeX `---` and `--`. Use a comma, a period, a colon, or restructure.
- "Not just X, it's Y" and its variants. Say Y.
- Participial tails: sentences ending `, ensuring X` or `, allowing Y`. Cut, or promote to a sentence.
- Transition glue opening a sentence: Moreover, Furthermore, Additionally, In conclusion, That said.
- Bolded label plus colon at the head of every bullet. Once is fine; a whole list of them reads as a template.
- Rule-of-three padding. Two items, or four, or one. Three by reflex is filler.
- Vague attribution: "studies show", "experts agree". Name the source or drop the claim.
- Politeness scaffolding: "great question", "I hope this helps", unprompted caveats.
<!-- strip-ai-tells: ignore-end -->

### 3. Word bans

Roughly forty patterns in `scripts/bans.txt`. Rewrite the sentence so the word is not needed. <!-- strip-ai-tells: ignore-start -->
Swapping in the nearest synonym defeats the check: "leverage" becoming "utilize" is the same sentence with the same problem.
<!-- strip-ai-tells: ignore-end --> See `references/rewriting.md` for how to dissolve each class rather than substitute.

### 4. Specificity audit (judgment, not scripted)

Every claim needs a detail a reader could check: a number, a name, a date, a version, a dollar figure. A claim without one gets cut, not softened into abstraction.

No script can do this, because it requires knowing whether the detail is true. Walk the draft claim by claim and ask what a skeptical reader would want to verify. If the answer is "nothing in here is checkable", the passage is decoration.

Do not invent a specific to satisfy this check. A missing number means the claim comes out. This matters most in a cover letter, where an invented number is a lie to an employer.

### 5. Section symmetry

Sections of near-identical length are an artifact of planning, not of argument. The script flags three or more sections whose word counts cluster tightly. Let the structure follow what is actually being said: some sections are a paragraph, some are a page.

### 6. Ending check

If the last paragraph restates what came before, or reaches for uplift about the future, delete it. End when the argument ends. The script flags summary openers and uplift phrasing; the judgment about whether the paragraph earns its place stays human.

### 7. Author check (judgment, not scripted)

If anyone could have written this, about anything, it has no voice. Read the draft and ask what in it could only have come from this writer: a specific opinion, an admission, a piece of hard-won knowledge, a position someone could disagree with.

If nothing qualifies, put one back in. This usually means committing to a claim in the first paragraph instead of hedging into vapor, or keeping a rough edge that a smoothing pass would have removed.

## The overcorrection guard

Anti-AI prose is its own tell.

After stripping, check whether the result now performs authenticity: fragments everywhere, forced casualness, every sentence clipped to four words, a studied roughness that is just as uniform as what it replaced. The script flags a document where more than 30 percent of sentences run four words or shorter, or where four or more are near-fragments.

The target is human prose, not anti-AI prose. A long, well-built sentence is not a tell. Neither is a semicolon, a subordinate clause, or a word with four syllables. Dial back until the writing sounds like a person who writes well, rather than a person avoiding detection.

## What a clean run means

It means the listed tells are absent. Nothing more.

The script matches patterns someone thought to write down, which makes it blind to every tell nobody listed. Treat a clean run as the floor, then do checks 4 and 7 by reading. Prose can pass every mechanical check and still be empty.

## Relationship to the writing style guide

`.claude/skills/job-application-assistant/03-writing-style.md` governs how cover letters and CV prose get written, and it states its cliche rules in sentences. This skill governs the audit that runs afterward, applies to any prose, and carries the machine-readable list.

The two overlap and are maintained separately. When adding a rule to one, consider whether the other wants it.

For a cover letter, both apply: write to the style guide, then audit with this skill.

## Reporting results

Report as a short list of what was found and what was changed, with line references. State dismissed LOOK hits and why. State plainly when checks 4 or 7 turned up nothing fixable, rather than inventing a change to look thorough.

## Additional resources

- **`scripts/audit_prose.py`** - the mechanical checks, `--format json` for programmatic use
- **`scripts/bans.txt`** - the word and phrase list, editable
- **`references/rewriting.md`** - how to dissolve each class of banned word instead of substituting, with before and after pairs
- **`references/judgment-checks.md`** - worked examples of the specificity audit and the author check, including cases where the right call was to cut a paragraph
