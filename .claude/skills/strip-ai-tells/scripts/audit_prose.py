#!/usr/bin/env python3
"""Flag the patterns that mark prose as machine-written.

Usage:
  python audit_prose.py DRAFT.md
  python audit_prose.py DRAFT.md --format json
  cat draft.md | python audit_prose.py -

Exit status is 1 when anything was flagged, 0 when nothing was, so the script
can gate a delivery step. Standard library only.

Two severities, and the difference is the point:

  error   A mechanical certainty. An em dash is an em dash. Fix it.
  review  A heuristic that cannot read the sentence. It marks a place to
          look, and a human or Claude decides. Some of these are meant to
          fire on good prose.

Fenced code blocks, inline code, and link targets are excluded before any
check runs, because none of these rules govern code.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

BANS_FILE = Path(__file__).with_name("bans.txt")

# Sentence-ending punctuation that is not actually a sentence end.
ABBREVIATIONS = r"(?<!\bMr)(?<!\bMrs)(?<!\bDr)(?<!\bSt)(?<!\bvs)(?<!\be\.g)(?<!\bi\.e)(?<!\betc)(?<!\bPh\.D)"

TRANSITION_GLUE = [
    "moreover", "furthermore", "additionally", "in conclusion",
    "that said", "importantly", "notably", "ultimately",
    "first and foremost", "last but not least",
]

VAGUE_ATTRIBUTION = [
    r"studies show", r"research suggests", r"experts agree",
    r"it is widely (known|believed|accepted)", r"many believe",
    r"some would argue", r"research has shown",
]

POLITENESS = [
    r"great question", r"I hope this helps", r"happy to help",
    r"let me know if", r"feel free to", r"as you (probably )?know",
    r"thanks for (asking|reaching out)",
]

SUMMARY_OPENERS = [
    "in summary", "in conclusion", "to summarize", "to sum up",
    "overall", "ultimately", "in short", "all in all",
    "at the end of the day", "the bottom line",
]


def load_bans(path: Path = BANS_FILE):
    """Read the ban list. Same format as the repo's split-identifiers.txt."""
    if not path.exists():
        return []
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip() if raw.lstrip().startswith("#") else raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            out.append((line, re.compile(line, re.IGNORECASE)))
        except re.error:
            continue
    return out


def mask_code(text: str) -> str:
    """Blank out everything these rules do not govern, preserving offsets.

    Offsets are preserved so reported line numbers still point at the real
    file. Masked out: code in every form, link targets, URLs, and markdown
    structure that would otherwise read as prose punctuation. YAML frontmatter
    delimiters and table separator rows are both literally '---', which the
    LaTeX dash check would otherwise flag on nearly every document here.

    Blockquotes are masked because quoted material belongs to whoever said it.
    Rewriting someone else's sentence to pass a style check misquotes them.

    A region between '<!-- strip-ai-tells: ignore-start -->' and
    '<!-- strip-ai-tells: ignore-end -->' is masked too, for documents that
    must show bad prose in order to teach it.
    """
    def blank(m):
        return re.sub(r"\S", " ", m.group(0))

    # Opt-out regions first, so anything inside them is exempt from everything.
    text = re.sub(r"<!--\s*strip-ai-tells:\s*ignore-start\s*-->.*?"
                  r"<!--\s*strip-ai-tells:\s*ignore-end\s*-->",
                  blank, text, flags=re.S | re.I)

    # YAML frontmatter, delimiters included.
    text = re.sub(r"\A---\n.*?\n---[ \t]*$", blank, text, flags=re.S | re.M)

    text = re.sub(r"```.*?```", blank, text, flags=re.S)
    text = re.sub(r"~~~.*?~~~", blank, text, flags=re.S)
    text = re.sub(r"`[^`\n]+`", blank, text)
    text = re.sub(r"\]\([^)]*\)", blank, text)          # markdown link targets
    text = re.sub(r"^\s{4,}\S.*$", blank, text, flags=re.M)  # indented code
    text = re.sub(r"https?://\S+", blank, text)
    text = re.sub(r"^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$", blank, text, flags=re.M)
    text = re.sub(r"^\s*>.*$", blank, text, flags=re.M)  # blockquotes
    text = re.sub(r"^\s*<!--.*?-->\s*$", blank, text, flags=re.M | re.S)
    return text


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def split_sentences(block: str):
    """Yield (sentence, offset) pairs. Naive but adequate for prose review."""
    pattern = re.compile(rf"{ABBREVIATIONS}[.!?]+[\"')\]]*\s+")
    start, out = 0, []
    for m in pattern.finditer(block):
        piece = block[start:m.end()].strip()
        if piece:
            out.append((piece, start))
        start = m.end()
    tail = block[start:].strip()
    if tail:
        out.append((tail, start))
    return out


def word_count(s: str) -> int:
    return len(re.findall(r"[A-Za-z0-9'’\-]+", s))


def paragraphs(text: str):
    """Yield (paragraph, offset) for prose paragraphs, skipping lists/headings."""
    for m in re.finditer(r"(?:^|\n\n+)([^\n].*?)(?=\n\n|\Z)", text, flags=re.S):
        para, off = m.group(1), m.start(1)
        stripped = para.lstrip()
        if stripped.startswith(("#", ">", "|", "-", "*", "+")):
            continue
        if re.match(r"^\d+[.)]\s", stripped):
            continue
        yield para, off


def add(findings, check, severity, text, index, message, excerpt):
    findings.append({
        "check": check,
        "severity": severity,
        "line": line_of(text, index),
        "message": message,
        "excerpt": excerpt.strip()[:160],
    })


# --------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------

def check_dashes(text, masked, findings):
    for m in re.finditer(r"[—–]", masked):
        add(findings, "dashes", "error", text, m.start(),
            "Em or en dash. Use a comma, a period, a colon, or restructure.",
            masked[max(0, m.start() - 60):m.start() + 60])
    for m in re.finditer(r"(?<!-)---(?!-)|(?<![-\d])--(?![->\d])", masked):
        add(findings, "dashes", "error", text, m.start(),
            "LaTeX en/em dash. Dates take a hyphen-minus with spaces.",
            masked[max(0, m.start() - 60):m.start() + 60])


def check_not_just(text, masked, findings):
    pat = re.compile(
        r"\b(not|isn'?t|aren'?t|wasn'?t)\s+(just|only|merely|simply|about)\b[^.!?\n]{0,90}?,\s*(it'?s|they'?re|it is|this is)\b",
        re.IGNORECASE)
    for m in pat.finditer(masked):
        add(findings, "not-just-x", "error", text, m.start(),
            "\"Not just X, it's Y\" construction. Say Y.",
            m.group(0))


def check_participial_tails(text, masked, findings):
    pat = re.compile(
        r",\s+(ensuring|allowing|enabling|making|helping|providing|creating|"
        r"giving|offering|delivering|driving|fostering|highlighting|"
        r"showcasing|underscoring|reflecting)\b[^.!?\n]*[.!?]",
        re.IGNORECASE)
    for m in pat.finditer(masked):
        add(findings, "participial-tail", "error", text, m.start(),
            "Participial tail. Cut it or make it its own sentence.",
            m.group(0))


def check_transition_glue(text, masked, findings):
    """Glue is a tell wherever a sentence starts with it, not only paragraphs."""
    for para, off in paragraphs(masked):
        for sent, s_off in split_sentences(para):
            head = sent.lstrip()
            low = head.lower()
            for glue in TRANSITION_GLUE:
                if low.startswith(glue) and (
                        len(low) == len(glue) or not low[len(glue)].isalnum()):
                    where = "Paragraph" if s_off == 0 else "Sentence"
                    add(findings, "transition-glue", "error", text, off + s_off,
                        f"{where} opens with \"{head[:len(glue)]}\". Cut it.",
                        head[:100])
                    break


def check_bold_label_bullets(text, masked, findings):
    hits = list(re.finditer(r"^\s*[-*+]\s+\*\*[^*\n]{1,60}:?\*\*:?\s", masked, flags=re.M))
    if len(hits) >= 3:
        add(findings, "bold-label-bullets", "review", text, hits[0].start(),
            f"{len(hits)} bullets open with a bold label and colon. "
            "Fine once; a whole list of them reads as a template.",
            hits[0].group(0))


# A real list has three content words in it. Discourse markers and pronouns
# either side of an "and" look identical to a regex and are not a list at all:
# "shake something loose, though, and it is ..." is prose, not a rule of three.
NOT_LIST_ITEMS = {
    "though", "however", "again", "too", "instead", "therefore", "then",
    "also", "yet", "so", "still", "rather", "indeed", "perhaps", "maybe",
    "it", "he", "she", "they", "we", "i", "you", "this", "that", "these",
    "those", "there", "here", "who", "which", "what", "the", "a", "an",
    "is", "was", "are", "were", "be", "been", "has", "have", "had", "do",
    "does", "did", "if", "when", "while", "because", "since", "now",
}


def check_rule_of_three(text, masked, findings):
    pat = re.compile(
        r"\b(\w+(?:ly)?),\s+(\w+(?:ly)?),?\s+and\s+(\w+(?:ly)?)\b(?=[\s,.;:])",
        re.IGNORECASE)
    for m in pat.finditer(masked):
        a, b, c = m.group(1), m.group(2), m.group(3)
        items = [a.lower(), b.lower(), c.lower()]
        if len(set(items)) < 3:
            continue
        if any(i in NOT_LIST_ITEMS for i in items):
            continue
        add(findings, "rule-of-three", "review", text, m.start(),
            "Three-item list. If the third is filler, use two or four.",
            m.group(0))


def check_vague_attribution(text, masked, findings):
    for phrase in VAGUE_ATTRIBUTION:
        for m in re.finditer(phrase, masked, re.IGNORECASE):
            add(findings, "vague-attribution", "error", text, m.start(),
                "Unnamed source. Name it or drop the claim.", m.group(0))


def check_politeness(text, masked, findings):
    for phrase in POLITENESS:
        for m in re.finditer(phrase, masked, re.IGNORECASE):
            add(findings, "politeness", "error", text, m.start(),
                "Politeness scaffolding. Delete it and start at the point.",
                m.group(0))


def check_banned_words(text, masked, findings, bans):
    for pattern, rx in bans:
        for m in rx.finditer(masked):
            add(findings, "banned-word", "error", text, m.start(),
                f"\"{m.group(0)}\" is an AI tell. Rewrite so the word is not "
                "needed; do not swap in a synonym.",
                masked[max(0, m.start() - 50):m.start() + 50])


def check_rhythm(text, masked, findings):
    for para, off in paragraphs(masked):
        sents = split_sentences(para)
        if len(sents) < 3:
            continue
        counts = [(word_count(s), idx) for s, idx in sents]
        run = []
        for wc, idx in counts:
            if 15 <= wc <= 20:
                run.append((wc, idx))
                if len(run) == 3:
                    add(findings, "rhythm-band", "review", text, off + run[0][1],
                        f"Three consecutive sentences of {run[0][0]}, {run[1][0]}, "
                        f"{run[2][0]} words, all in the 15-20 band. Break one.",
                        para[run[0][1]:run[0][1] + 110])
                    run = []
            else:
                run = []
        for i in range(len(counts) - 2):
            window = [counts[i][0], counts[i + 1][0], counts[i + 2][0]]
            if max(window) - min(window) <= 2 and min(window) >= 8:
                add(findings, "rhythm-flat", "review", text, off + counts[i][1],
                    f"Three consecutive sentences of {window} words. "
                    "Vary the length hard: put a short one next to a long one.",
                    para[counts[i][1]:counts[i][1] + 110])
                break


def check_section_symmetry(text, masked, findings):
    heads = list(re.finditer(r"^(#{1,6})\s+(.+)$", masked, flags=re.M))
    if len(heads) < 3:
        return
    sizes = []
    for i, h in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(masked)
        sizes.append((word_count(masked[h.end():end]), h.group(2).strip(), h.start()))
    bodies = [s for s, _, _ in sizes if s > 0]
    if len(bodies) < 3:
        return
    spread = max(bodies) - min(bodies)
    if spread <= max(12, 0.15 * (sum(bodies) / len(bodies))):
        add(findings, "section-symmetry", "review", text, sizes[0][2],
            f"{len(bodies)} sections within {spread} words of each other. "
            "Even sections are an artifact of planning, not of argument.",
            ", ".join(t for _, t, _ in sizes[:4]))


def check_ending(text, masked, findings):
    paras = list(paragraphs(masked))
    if not paras:
        return
    last, off = paras[-1]
    low = last.lstrip().lower()
    for opener in SUMMARY_OPENERS:
        if low.startswith(opener):
            add(findings, "ending", "review", text, off,
                f"Last paragraph opens with \"{opener}\". If it only restates, "
                "delete it. End when the argument ends.",
                last[:120])
            return
    if re.search(r"\b(bright future|exciting journey|look forward to|"
                 r"the possibilities are|only the beginning)\b", low):
        add(findings, "ending", "review", text, off,
            "Last paragraph reaches for uplift. Cut it.", last[:120])


def check_overcorrection(text, masked, findings):
    """The guard on the guard: anti-AI prose is its own tell."""
    all_sents = []
    for para, _ in paragraphs(masked):
        all_sents.extend(word_count(s) for s, _ in split_sentences(para))
    if len(all_sents) < 8:
        return
    very_short = sum(1 for w in all_sents if w <= 4)
    if very_short / len(all_sents) > 0.3:
        add(findings, "overcorrection", "review", text, 0,
            f"{very_short} of {len(all_sents)} sentences are 4 words or fewer. "
            "This reads as performed authenticity. Dial it back.",
            "(whole document)")
    frags = sum(1 for w in all_sents if w <= 2)
    if frags >= 4:
        add(findings, "overcorrection", "review", text, 0,
            f"{frags} near-fragment sentences. Human prose, not anti-AI prose.",
            "(whole document)")


CHECKS = [
    check_dashes, check_not_just, check_participial_tails,
    check_transition_glue, check_bold_label_bullets, check_rule_of_three,
    check_vague_attribution, check_politeness, check_rhythm,
    check_section_symmetry, check_ending, check_overcorrection,
]


def audit(text: str, bans):
    masked = mask_code(text)
    findings = []
    for fn in CHECKS:
        fn(text, masked, findings)
    check_banned_words(text, masked, findings, bans)
    findings.sort(key=lambda f: (f["line"], f["check"]))
    return findings


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="file to audit, or - for stdin")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--only", choices=["error", "review"],
                    help="show one severity only")
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")

    args = ap.parse_args(argv)

    text = sys.stdin.read() if args.path == "-" else Path(args.path).read_text(encoding="utf-8")
    findings = audit(text, load_bans())
    if args.only:
        findings = [f for f in findings if f["severity"] == args.only]

    if args.format == "json":
        print(json.dumps({"findings": findings,
                          "errors": sum(1 for f in findings if f["severity"] == "error"),
                          "review": sum(1 for f in findings if f["severity"] == "review")},
                         indent=2))
        return 1 if findings else 0

    if not findings:
        print("No tells found. That is not proof the prose is good; the script "
              "only knows the patterns on its list.")
        return 0

    errors = [f for f in findings if f["severity"] == "error"]
    review = [f for f in findings if f["severity"] == "review"]
    for label, group in (("FIX", errors), ("LOOK", review)):
        if not group:
            continue
        print(f"\n{label} ({len(group)})")
        print("-" * 70)
        for f in group:
            print(f"  line {f['line']:>4}  [{f['check']}] {f['message']}")
            if f["excerpt"] and f["excerpt"] != "(whole document)":
                print(f"              > {f['excerpt']}")
    print(f"\n{len(errors)} to fix, {len(review)} to look at.")
    print("A clean run means the listed tells are absent, nothing more. "
          "Checks 4 and 7 of the skill are judgement and do not appear here.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
