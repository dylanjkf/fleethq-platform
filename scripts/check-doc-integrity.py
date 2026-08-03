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
    not\ present | there\ is\ no | there'?s\ no | nothing\ to\ `?terraform |
    stands\ in\ for | remainder | small\ remainder | until\ (?:a|an|the|we)
    """,
)

WINDOW = 5  # a qualifier this many lines before/after the claim counts as adjacent


def scan_lines(lines: list[str]) -> list[tuple[int, str]]:
    violations = []
    for i, line in enumerate(lines):
        if not CLAIM.search(line):
            continue
        lo = max(0, i - WINDOW)
        hi = min(len(lines), i + WINDOW + 1)
        if any(QUALIFIER.search(lines[j]) for j in range(lo, hi)):
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
