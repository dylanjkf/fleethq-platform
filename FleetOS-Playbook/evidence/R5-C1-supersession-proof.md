# R5 Critical #1 — forced-supersession proof (durable evidence)

The Round-4 changelog claimed the deploy race was closed; direct inspection in R5
found the guard computed `SUPERSEDED=1` but nothing enforced it — Install/Deploy
had no `if:` and ran anyway. R5 made the guard **fail-closed** (`exit 1`) and added
`if: env.SUPERSEDED != '1'` to the downstream steps. This file records the real
forced-supersession run that proves it (not a YAML re-read).

## Experiment

Two commits were merged to `main` back-to-back, both touching `api/**` so each
triggered `api-ci` → `deploy-api`:

- **A (older):** `ce769db0c5f7c71f0729d6cc69477002861f064a` — PR #28
- **B (newer):** `4d0674a912702aa04f4f87047f89a01679e4dabb` — PR #29 (became `main` tip)

`api-ci` has no `concurrency` block, so both runs completed independently; A's
deploy therefore fired **after** B was already on `main`.

## Result — the superseded deploys stood down (deploy step never executed)

**deploy-api for A** — run https://github.com/dylanjkf/fleethq-platform/actions/runs/30859124698 → **conclusion: failure** (at the guard). Job log:

```
Deploying: ce769db0c5f7c71f0729d6cc69477002861f064a
main tip:  4d0674a912702aa04f4f87047f89a01679e4dabb
##[error]main has already advanced past ce769db0... to 4d0674a0... — standing down (fail-closed) to avoid shipping stale code over newer.
##[error]Process completed with exit code 1.
Post job cleanup.
```

The job went straight from the guard's `exit 1` to *Post job cleanup* — the
**"Install Railway CLI", "Deploy api/ to Railway", and "Post-deploy smoke test"
steps did NOT execute.** `railway up` never ran for the superseded commit.

(The R5 merge commit `b6c0c3bb…` was likewise superseded by B and stood down the
same way — run https://github.com/dylanjkf/fleethq-platform/actions/runs/30859045378, failure at the guard.)

## Result — the newest commit deployed normally

**deploy-api for B** — run https://github.com/dylanjkf/fleethq-platform/actions/runs/30859127650 → **conclusion: success**. Step timeline:

| step | conclusion |
|---|---|
| Recency guard | success (B == main tip → proceeded) |
| Preflight | success |
| Install Railway CLI | success |
| **Deploy api/ to Railway** | **success** (`railway up`, 22:34:17 → 22:36:02) |
| **Post-deploy smoke test /health/ready** | **success** |

So exactly one deploy shipped (the newest), and the two superseded deploys were
refused — the out-of-order race is closed and enforced, not merely detected.

## Note on the H4 smoke test

In run 30859127650 the smoke-test step ran and passed via its documented
warn-and-pass path (`API_HEALTH_URL` repo Variable not yet set). Once that
variable is set to the API's public `/health/ready` URL, the step hard-fails the
deploy unless it gets `200 + "status":"ok"`, making the deploy self-verifying.
