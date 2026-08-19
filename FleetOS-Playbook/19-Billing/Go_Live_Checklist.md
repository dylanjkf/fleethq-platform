# FleetHQ Billing — Go-Live Checklist (founder actions)

Everything **you** need to do before self-serve signup + flat monthly billing can
go live. Grouped by system, in the order that unblocks the most. Items marked
**🔴 BLOCKS TESTING** gate my end-to-end verification, so start those first.
Items marked **🟡 DECISION** need an answer from you (defaults I'm using are noted).

The code follows one rule: **Stripe is the source of truth.** So most of this list
is configuring your Stripe account correctly — the app just mirrors it.

---

## 1. Stripe account

- [ ] **🔴 Create / confirm your Stripe account** is a **live** account with an
      Australian business entity, in **AUD**, and that your bank account for
      payouts is connected and verified.
- [ ] **🔴 Get your API keys** (Dashboard → Developers → API keys):
      - Secret key (`sk_live_…`) → env `STRIPE_SECRET_KEY`
      - You do **not** need the publishable key — Checkout is hosted, so the app
        never handles card data.
- [ ] **🔴 Create the Product + Price** (Dashboard → Product catalog → Add product):
      - Product name: **FleetHQ Subscription**
      - Price: **A$29.00**, **Recurring**, **Monthly**, **usage type = Licensed**
        (a single flat price — quantity is always 1, *not* metered/usage-based and
        *not* per-asset).
      - Copy the resulting **Price ID** (`price_live_…`) → env `STRIPE_PRICE_MONTHLY`.
      - I'll also store it (and the Product id) into the `billing_settings` row so
        it's in one place.
- [ ] **🔴 Enable Stripe Tax** (Dashboard → Settings → Tax) and register your
      **AU GST** there. **Do not** set `STRIPE_TAX_ENABLED=true` until this is done —
      turning it on before registration makes Stripe reject every checkout.
      - 🟡 **DECISION:** Stripe Tax auto-detection vs. a single manual 10% GST Tax
        Rate. *My default recommendation:* since your customer base is Australia-only,
        **Stripe Tax with AU registration** is simplest and keeps invoices correct.
        Confirm and I'll wire whichever you pick.
- [ ] **Configure dunning / Smart Retries** (Dashboard → Settings → Billing →
      Subscriptions and emails → *Manage failed payments*):
      - Turn on **Smart Retries** (or set a fixed retry schedule).
      - Set what happens **after retries are exhausted** → **mark subscription
        `unpaid`** (this is what flips the app into read-only). Note the number of
        retries/days so the in-app "payment failed" messaging matches reality.
- [ ] **Turn on Stripe's automatic emails** (Dashboard → Settings → Billing →
      *Customer emails*): "Successful payments" (receipts) and "Failed payments".
      This is your invoice/receipt delivery — the app also shows invoices in-app.
- [ ] **Branding** (Dashboard → Settings → Branding): logo, brand colour, business
      name — these appear on the hosted Checkout page and invoices.

## 2. Tax-invoice details

- [ ] **🟡 DECISION — give me your ABN** (11 digits). It's stored in
      `billing_settings.abn` (currently **null** — I did **not** hardcode a
      placeholder) and attached to Stripe as your business tax id so it prints on
      every GST tax invoice.
- [ ] **🟡 DECISION — invoice footer / legal text** (optional): any wording you
      want on the invoice footer (e.g. "Tax Invoice — FleetHQ Pty Ltd, ABN …").
      Confirm exact text + whether you want it in the footer or a custom field.
- [ ] Confirm your **registered business name** and address as it should appear on
      invoices (set in Stripe → Settings → Business).

## 3. Webhooks (how Stripe tells the app about payments)

- [ ] **🔴 Create a webhook endpoint** (Dashboard → Developers → Webhooks → Add
      endpoint):
      - URL: `https://<your-api-domain>/v1/billing/webhook`
      - Events to send (or "all events" is fine): `checkout.session.completed`,
        `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`,
        `customer.subscription.created`, `.updated`, `.deleted`, `.paused`,
        `.trial_will_end`, `charge.dispute.created`, `charge.refunded`.
      - Copy the **Signing secret** (`whsec_…`) → env `STRIPE_WEBHOOK_SECRET`.
- [ ] Confirm the API is reachable from the public internet at that URL over
      **HTTPS** (the endpoint verifies Stripe's signature and rejects anything else).

## 4. Environment variables (set via your existing secrets mechanism)

On the **API** (fleethq-platform) production environment:

| Variable | Value | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` | 🔴 never commit/log |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | 🔴 from the webhook endpoint above |
| `STRIPE_PRICE_MONTHLY` | `price_live_…` | 🔴 the $29/month flat price |
| `STRIPE_TAX_ENABLED` | `true` | **only after** GST registration (§1) |
| `BILLING_ENFORCED` | `true` | **flips plan feature-gating + payment-failure read-only ON.** (Flat pricing has no asset cap.) Leave unset until you've tested — see §7 |
| `APP_BASE_URL` | `https://app.fleethq…` | used for Checkout success/cancel + redirect allowlist |
| `CORS_ALLOWED_ORIGINS` | your app + website origins | so the signup redirect is allowed |

On the **website** (FleetHQWebsite) production environment:

| Variable | Value | Notes |
|---|---|---|
| Sign-up target URL | `https://app.fleethq…/signup` | where the new "Sign Up" button points |

## 5. Domains / routing

- [ ] **🟡 DECISION — confirm the domains.** The "Sign Up" button lives on the
      marketing site and points at the app's `/signup`. Tell me the exact hostnames
      (e.g. `www.fleethq.com.au` for the site, `app.fleethq.com.au` for the app) so
      the button target, `success_url`, `cancel_url`, and CORS are all correct.
- [ ] Confirm SSL certs are valid on both hosts (Checkout will only redirect back
      to HTTPS origins on the allowlist).

## 6. Email (welcome / receipt)

- [ ] Confirm the transactional email provider is configured in production (the app
      already has an email channel — I'll reuse it, not add a new one).
- [ ] **🟡 DECISION — welcome email content/branding**: sign-off name, support
      address, any copy you want in the "Welcome to FleetHQ" email sent on
      successful signup. (Stripe sends the payment receipt separately.)

## 7. Turning it on safely (test mode first)

- [ ] Do a **full dry run in Stripe test mode** first (test keys + test Price +
      `4242 4242 4242 4242`): sign up → pay the flat $29 → land logged in → add as
      many assets as you like (no cap) → confirm the invoice is the flat $29
      regardless of fleet size.
      *(This is the run I'll do for you once the keys above exist — it's why the
      🔴 items block testing.)*
- [ ] Only after that passes, set the **live** keys and **`BILLING_ENFORCED=true`**.
      Enforcement is off by default precisely so nothing bites before you're ready —
      until it's `true`, the cap and read-only mode are inert.
- [ ] **⚠️ Existing companies:** enabling `BILLING_ENFORCED` applies feature-gating
      to *every* company. Any existing tenant without a subscription drops to the Free
      fallback. Before flipping it, decide how to handle current tenants (grandfather
      them onto the flat $29/month subscription, or leave them on Free). Flat pricing
      has no per-asset cap, so there is no quantity to backfill — a tenant is either
      subscribed (flat $29) or on the Free fallback. **Ask me to prepare a one-off
      backfill** (attach subscriptions to existing companies) before go-live if you
      want current tenants grandfathered.

## 8. Optional / lower-priority decisions

- [ ] **🟡 CAPTCHA** on the signup form. Default: honeypot + per-IP/email
      rate-limit (built in, no dependency). If you want a CAPTCHA, tell me the
      provider (reCAPTCHA / hCaptcha / Turnstile) and I'll add it.
- [ ] **🟡 Alert channel** for billing alerts (provisioning-failed-after-payment
      is the critical one, plus repeated payment failures, cap-block spikes, webhook
      signature failures). Default: existing email/notification infra. Give me a
      **Slack webhook URL** if you'd prefer Slack.
- [ ] **🟡 Same-email policy.** Default: an email that already has a FleetHQ account
      is **blocked** from self-serve signup ("sign in instead"). Say if you'd rather
      allow one email to own multiple companies.
- [ ] Disposable-email blocking on signup — off by default; say if you want it.

## 9. Legal

- [ ] Confirm the **Terms of Service / cancellation policy** wording shown on the
      signup page ("$29 AUD per month for the whole account, flat, billed monthly,
      after a 7-day free trial, with a 12-month minimum term" — see Part 2; the old
      "cancel anytime" phrasing no longer applies).
      Point me at the ToS/Privacy URLs if they should link out.

---

### Quick "am I ready?" gate
You're ready to flip `BILLING_ENFORCED=true` in production once **every 🔴 item** is
done, the **test-mode dry run** passed, and you've decided how existing tenants are
handled (§7). Everything 🟡 can be filled in around that, but the ABN and Tax
registration should be done before the *first real* invoice is generated.
