#!/usr/bin/env python3
"""
Documentation-integrity guard (Round 4).

Fails if any documentation line makes a *present-tense infrastructure claim*
about infrastructure that is not actually deployed (the app runs on Railway +
Vercel, not the AWS/Terraform stack the playbook describes as its target), unless
a "planned / not-yet" qualifier appears WITHIN A FEW LINES of the claim.

Why proximity-scoped: earlier rounds "fixed" files by adding a banner at the top
of the file while leaving a false present-tense claim 100 lines below it intact.
A banner far from the claim no longer counts — the qualifier must be adjacent
(same line or within WINDOW lines), so the reader sees "planned" right where the
claim is made.

Run locally:  python3 scripts/check-doc-integrity.py
CI:           same, non-zero exit fails the build.
"""
from __future__ import annotations
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Directories/files scanned. Entire doc tree, not a named subset.
SCAN_DIRS = ["docs", "FleetOS-Playbook"]
SCAN_ROOT_FILES = ["README.md"]

# Never scanned:
#  - CHANGELOG is a historical record; entries legitimately quote the pattern
#    while describing how it was corrected.
#  - this script contains the vocabulary on purpose (and self-tests in-process
#    via `--selftest`, no on-disk fixture needed).
EXEMPT_SUFFIXES = (
    os.path.join("FleetOS-Playbook", "CHANGELOG.md"),
    os.path.join("scripts", "check-doc-integrity.py"),
)

# Present-tense infrastructure vocabulary that describes the *target* AWS stack,
# which does not exist in this repo. S3/SES/Stripe/Sentry/OpenStreetMap are
# deliberately excluded — those integrations are really implemented (behind
# config), so mentioning them is not a fabrication.
CLAIM = re.compile(
    r"""(?xi)
    \b(
        RDS | ECS | EKS | ECR | Fargate | CloudWatch | CloudTrail | CloudFront |
        CloudFormation | Secrets\ Manager | GuardDuty | KMS | SSE-KMS | Terraform |
        Application\ Load\ Balancer | ALB | Route\ ?53 | DynamoDB | VPC |
        auto[-\ ]?scal(?:e|es|ing) | Web\ Application\ Firewall | \bWAF\b |
        point[-\ ]in[-\ ]time\ recovery | \bPITR\b | ap-southeast |
        infra/terraform
    )\b
    | encrypt(?:ion|ed)?[^.\n]{0,40}\bat[-\ ]rest
    | \bat[-\ ]rest\b[^.\n]{0,40}encrypt
    """,
)

# Qualifiers that make a claim honest when they appear near it. Includes the
# planned/deferred vocabulary AND the markers of the encryption that IS real
# (the Integration Hub's application-level AES-256-GCM credential vault), so a
# correctly-scoped at-rest sentence isn't a false positive.
QUALIFIER = re.compile(
    r"""(?xi)
    planned | target\ (?:architecture|state|iac) | not\ yet | does\ not\ exist\ yet |
    not\ (?:yet\ )?(?:built|provisioned|implemented|deployed) | roadmap |
    aspirational | intended | deferred | when\ we\ migrate | future\ state |
    AES-256-GCM | application-level | column-level | field-level |
    provider'?s\ default | managed\ (?:host|platform|database)'?s?\ default |
    planned-infra-doc |
    # honest negations / gap phrasing: the line is denying, not asserting, that the
    # infra exists — those are exactly the statements the guard should NOT flag.
    # NB: deliberately NOT accepting bare "deferred" / "until …" as qualifiers —
    # "deployment is deferred until X" describes *timing*, not *non-existence*, and
    # previously let a present-tense "Terraform modules under infra/ (ECS/RDS/…)"
    # existence claim slip through. An existence claim must be qualified by a
    # not-built / planned marker, not by a word about when deployment happens.
    not\ present | there\ is\ no | there'?s\ no | nothing\ to\ `?terraform |
    stands\ in\ for | remainder | small\ remainder | not\ (?:yet\ )?in\ (?:the\ )?repo
    """,
)

WINDOW = 3  # a qualifier this many lines before/after the claim counts as adjacent.
# Deliberately tight (was 5): a ±5 window let a qualifier belonging to a *different*
# bullet excuse a bare existence claim (e.g. a "Secrets Manager in production" aside
# passed because an unrelated "planned" line sat 4 lines away). 3 still covers a
# multi-line "Planned (target …): …" block where the qualifier heads the paragraph,
# but no longer leaks across unrelated list items.


HEADER = re.compile(r"^\s{0,3}#{1,6}\s")

# Markdown emphasis/inline-code markers, stripped before QUALIFIER matching so that
# an honest negation like "There is **no** Terraform" isn't missed just because a
# bold marker splits "is no". Applied to qualifier detection only — CLAIM detection
# is left as-is so claims are still caught.
_EMPHASIS = re.compile(r"[*_`]")


def _has_qualifier(line: str) -> bool:
    return bool(QUALIFIER.search(_EMPHASIS.sub("", line)))


# A claim that explicitly asserts it is live *now* ("in production", "already
# provisioned") must NOT be rescued by a governing "(planned)" section header —
# a planned header can't make an in-production claim honest. Kept narrow so it
# does not catch honest reality phrasing like "in the current deployment …".
CURRENT_ASSERTION = re.compile(
    r"(?i)\bin\ production\b|\balready\ (?:has|have|exists?|provisioned|installed|configured|deployed)\b",
)


def _asserts_current(line: str) -> bool:
    return bool(CURRENT_ASSERTION.search(_EMPHASIS.sub("", line)))


def _governing_header_qualified(lines: list[str], i: int) -> bool:
    """True if the nearest markdown header at or above line i carries a qualifier.

    A `### Encryption at rest (planned)` header governs every bullet beneath it
    until the next header, so a claim in that block is qualified even when the
    header is further than WINDOW lines away. This is what lets the window stay
    tight (cross-bullet leak protection) without false-positiving on clearly
    planned sections.
    """
    for j in range(i, -1, -1):
        if HEADER.match(lines[j]):
            return _has_qualifier(lines[j])
    return False


def scan_lines(lines: list[str]) -> list[tuple[int, str]]:
    violations = []
    for i, line in enumerate(lines):
        if not CLAIM.search(line):
            continue
        # A claim that asserts it is live *now* ("in production", "already
        # provisioned") is only honest if the same sentence qualifies/negates it.
        # Checked within ±1 line (to cover a wrapped sentence) — NOT the full window
        # and NOT a governing header, so a "planned" word on a different bullet or a
        # section header can't make an in-production claim true.
        if _asserts_current(line):
            near = range(max(0, i - 1), min(len(lines), i + 2))
            if not any(_has_qualifier(lines[j]) for j in near):
                violations.append((i + 1, line.rstrip()))
            continue
        lo = max(0, i - WINDOW)
        hi = min(len(lines), i + WINDOW + 1)
        if any(_has_qualifier(lines[j]) for j in range(lo, hi)):
            continue
        # A governing "(planned)" header rescues a planned-topology bullet.
        if _governing_header_qualified(lines, i):
            continue
        violations.append((i + 1, line.rstrip()))
    return violations


def scan_file(path: str) -> list[tuple[int, str]]:
    with open(path, encoding="utf-8") as fh:
        return scan_lines(fh.readlines())


# Red-team self-test: the gate must FAIL a fabricated claim and PASS a correctly
# qualified one. Run on every CI invocation (`--selftest`) so the guard can never
# silently rot into a no-op — a regression in the regex fails the build directly.
SELFTEST_CASES = [
    # (description, lines, expect_violation)
    (
        "bare fabricated present-tense AWS claim",
        ["The production database runs on AWS RDS with KMS encryption at rest.\n"],
        True,
    ),
    (
        "fabricated Terraform-provisioned topology",
        ["All traffic flows client -> CloudFront -> ALB -> ECS Fargate tasks in a VPC.\n"],
        True,
    ),
    (
        "fabricated secrets store",
        ["Runtime secrets are pulled from AWS Secrets Manager via OIDC.\n"],
        True,
    ),
    (
        "same claim, correctly qualified adjacently -> must pass",
        [
            "Target architecture (planned, not yet built):\n",
            "The production database runs on AWS RDS with KMS encryption at rest.\n",
        ],
        False,
    ),
    (
        "real controls that must NOT be flagged",
        [
            "Integration credentials are encrypted at rest at the application layer "
            "(AES-256-GCM); attachments use S3 and email uses SES when configured.\n"
        ],
        False,
    ),
    (
        "honest negation with markdown bold splitting the phrase -> must pass",
        ["> There is **no** Terraform / infrastructure-as-code in this repository.\n"],
        False,
    ),
    (
        "planned section header governs its bullets beyond the window -> must pass",
        [
            "### Encryption at rest (planned)\n",
            "- some prose\n",
            "- more prose\n",
            "- more prose\n",
            "- RDS storage encrypted with a customer-managed KMS key; SSE-KMS buckets.\n",
        ],
        False,
    ),
    (
        "unqualified claim under a NON-planned header -> must still be flagged",
        [
            "### Current production\n",
            "- The API runs on ECS Fargate behind an ALB with RDS Postgres.\n",
        ],
        True,
    ),
    (
        "'in production' claim under a PLANNED header -> header must NOT excuse it",
        [
            "## Planned target\n",
            "- Something genuinely planned (not yet built).\n",
            "- Unrelated real bullet.\n",
            "- Secrets are pulled from AWS Secrets Manager (infra/terraform/modules/secrets/) in production.\n",
        ],
        True,
    ),
    (
        "honest 'current deployment' reality line under a planned header -> must pass",
        [
            "### Encryption at rest (planned)\n",
            "- RDS with a customer-managed KMS key is the target.\n",
            "- No such infrastructure exists yet.\n",
            "- At-rest encryption in the current deployment is the managed platform's default (KMS is planned).\n",
        ],
        False,
    ),
]


def selftest() -> int:
    failures = 0
    for desc, lines, expect in SELFTEST_CASES:
        got = bool(scan_lines(lines))
        ok = got == expect
        status = "ok" if ok else "FAIL"
        print(f"  [{status}] {desc}: expected_violation={expect} got_violation={got}")
        if not ok:
            failures += 1
    if failures:
        print(f"\n✗ doc-integrity self-test: {failures} case(s) failed — the guard "
              f"is not behaving as designed. Do NOT trust it until fixed.")
        return 1
    print("✓ doc-integrity self-test: gate correctly flags fabricated claims and "
          "passes qualified/real ones.")
    return 0


def iter_docs():
    for d in SCAN_DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, _dirs, files in os.walk(base):
            for f in files:
                if f.endswith((".md", ".mdx")):
                    yield os.path.join(dirpath, f)
    for f in SCAN_ROOT_FILES:
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            yield p


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    total = 0
    for path in sorted(iter_docs()):
        rel = os.path.relpath(path, ROOT)
        if any(rel.endswith(s) for s in EXEMPT_SUFFIXES):
            continue
        for lineno, text in scan_file(path):
            print(f"{rel}:{lineno}: unqualified infrastructure claim: {text.strip()[:160]}")
            total += 1
    if total:
        print(f"\n✗ {total} unqualified infrastructure claim(s). Correct the claim, "
              f"or add a 'planned / not yet implemented' qualifier within {WINDOW} "
              f"lines of it.")
        return 1
    print("✓ doc-integrity: no unqualified infrastructure claims.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
