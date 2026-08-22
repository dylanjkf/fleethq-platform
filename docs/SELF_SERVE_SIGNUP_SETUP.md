# Self-serve signup + automatic Stripe billing — turn-on runbook

Self-serve signup is **already implemented end-to-end** in this codebase. It is
not a feature to build — it is a feature to *configure*. When the Stripe
environment variables below are unset, the API deliberately disables signup
(`SignupService.signupDisabledReason()`), the `/signup` page shows
"Self-serve signup isn't available right now — Contact us", and no account can
be created. Setting the four variables (plus a Stripe webhook) turns it on.

## What the feature does once enabled

1. A visitor fills the app signup form (`https://fleethq.online/signup`):
   company name, their name, work email, password, and how many assets to track.
2. `POST /v1/signup` creates a **Stripe Checkout Session** (mode `subscription`)
   for the per-asset price × quantity, with a **7-day free trial**
   (`TRIAL_PERIOD_DAYS`), and stages the intended account in `pending_signups`.
   No account exists yet — the password is bcrypt-hashed at this point.
3. The browser is redirected to Stripe's hosted Checkout to enter card details.
4. On success, Stripe fires **`checkout.session.completed`** to the webhook.
   `BillingService` → `SignupService.provisionFromCompletedCheckout` creates the
   real company + admin + subscription (idempotent and race-safe: only one
   webhook delivery wins; a failure rolls back for Stripe to retry).
5. The success page (`/signup/complete`) polls `GET /v1/signup/status` and, once
   provisioning is `COMPLETED`, is issued a **single-use login token** — the new
   admin lands straight in the app.
6. Ongoing billing (renewals, dunning/`invoice.payment_failed`, cancellations,
   pauses, trial-will-end, disputes) is handled by the same webhook.

Safety nets already in place: a reconciliation sweep re-drives provisioning if a
webhook is ever missed (customer paid but no account), and an expiry sweep marks
abandoned checkouts `EXPIRED`.

## Prerequisites

- A Stripe account (use **test mode** first, then repeat in **live mode**).
- Access to the API's environment (Railway → the `fleethq-platform` service).

## Step 1 — Create the per-asset recurring price in Stripe

Stripe Dashboard → **Product catalog** → add a product (e.g. "FleetHQ — per
asset"). Add a **recurring** price (monthly), currency AUD. Copy the **Price ID**
(`price_...`) — this is `STRIPE_PRICE_PER_ASSET`. The signup charges this price
with `quantity = assets to track`; the amount shown on the signup page is only a
preview — the real charge is always recomputed server-side.

## Step 2 — Set the API environment variables (Railway)

| Variable | Value | Why |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` / `sk_live_...` | Enables billing (`isConfigured()`); without it signup is `billing_not_configured`. |
| `STRIPE_PRICE_PER_ASSET` | `price_...` from Step 1 | The recurring per-asset price; without it signup is `no_per_asset_price`. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from Step 3 | Verifies webhook authenticity; provisioning won't run without it. |
| `APP_BASE_URL` | `https://fleethq.online` | Backs the Checkout success/cancel redirects and email links. **Required in production** — the API refuses to boot without it. |

Optional: enable automatic tax (`STRIPE_TAX_*` / `automatic_tax`) and the
welcome/verify email (`EMAIL_*` / SES) — signup works without them.

## Step 3 — Create the Stripe webhook

Stripe Dashboard → **Developers → Webhooks → Add endpoint**:

- **Endpoint URL:** `https://api.fleethq.online/v1/billing/webhook`
- **Events to send** (minimum for signup + ongoing billing):
  - `checkout.session.completed`  ← provisions the account
  - `customer.subscription.created`, `.updated`, `.deleted`, `.paused`
  - `customer.subscription.trial_will_end`
  - `invoice.paid`, `invoice.finalized`, `invoice.payment_failed`
  - `charge.dispute.created`
- Copy the endpoint's **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET` (Step 2), then redeploy the API.

## Step 4 — Confirm the front-end wiring (already done in code)

- Marketing site "Start now" → `https://fleethq.online/signup` (`NEXT_PUBLIC_APP_URL`).
- App points at the API via `VITE_API_URL` (`https://api.fleethq.online`).

## Verify

1. `curl https://api.fleethq.online/v1/signup/config` → expect
   `{"enabled":true,"disabledReason":null,...}`. If `enabled:false`, the
   `disabledReason` names the missing piece (`billing_not_configured` /
   `no_per_asset_price` / `no_app_base_url`).
2. In **test mode**, run a full signup and pay with Stripe's test card
   `4242 4242 4242 4242`, any future expiry, any CVC.
3. You should be redirected back and **logged straight in**. Confirm in the admin
   console (Organisations) that the new company exists with an active/trialing
   subscription, and that `billing_audit_logs` has `SIGNUP_STARTED` then
   `SIGNUP_COMPLETED`.
4. Repeat Steps 1–3 in **live mode** with live keys before taking real customers.

## Troubleshooting

- **`/signup` shows "not available"** → `GET /v1/signup/config` and read
  `disabledReason`. Set the corresponding variable and redeploy.
- **Paid but no account** → check the Stripe webhook delivery log for
  `checkout.session.completed` (URL + signing secret correct?). The reconciliation
  sweep also recovers these; a persistently failing one raises a
  `SIGNUP_PROVISION_FAILED` entry in `billing_audit_logs`.
- **"Signup is temporarily unavailable"** on submit → the API rejected it as
  `SIGNUP_NOT_CONFIGURED`; same cause as above.
