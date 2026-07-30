# Founder Notes: What's Missing, What Should Be Cut

This file is deliberately not written in the same neutral "constitution" voice as the rest of the repository. It's the honest co-founder take: gaps I see, and things in the plan I'd push back on before you spend engineering time on them.

## What I think is genuinely missing

**1. Data migration / onboarding from paper.** Every spec assumes assets, operators, and customers already exist in FleetOS. Nothing yet describes how a courier company with 10 years of paper records and an Excel sheet of assets actually gets started. This is the single biggest risk to your "10 minutes to first value" mission — if onboarding is painful, nothing else in this repo matters. I'd make this one of the very first Phase 2 additions, not an afterthought.

**2. Notifications as its own system.** Right now, "notify the workshop," "notify dispatch," "alert on fatigue risk" are mentioned inside half a dozen feature specs, each slightly differently. That's how you end up with five inconsistent notification implementations. This needs one cross-cutting spec: channels (push, in-app, SMS/email fallback for office staff who aren't staring at FleetHQ all day), user-configurable preferences, and — importantly — alert fatigue management, so a workshop manager doesn't get 40 pings and start ignoring all of them.

**3. Privacy and data protection, distinct from asset compliance.** `08-Compliance/` covers asset/fleet regulatory compliance (NHVR, CoR, fatigue). It does not cover the Australian Privacy Act obligations around storing operator personal data (licence numbers, medical info, location history). This is a separate legal surface and needs its own spec before you're handling real operator data.

**4. Billing and subscription management.** ✅ *Addressed (2026-07-22) — see `19-Billing/Billing_And_Subscriptions.md`.* A Stripe-backed subscription system is built end-to-end (checkout, Stripe-hosted portal, signature-verified webhooks, a FleetHQ Billing page, `billing:view`/`billing:manage` permissions) and fully testable in Stripe test mode; going live is a configuration step (real Stripe account + keys), not a code change. v1 deliberately *informs* rather than hard-locks-out on non-payment, and defers plan-tiers/modules-as-add-ons and dunning to Stripe's own dunning + a future enforcement milestone.

**5. Backup and disaster recovery.** `16-Deployment/` covers releases but not "what happens if the primary data store is corrupted or a region goes down." For a product a business runs its daily operations on, this needs an explicit RPO/RTO commitment before your first real customer, not after an incident.

**6. Asset and operator onboarding/decommissioning workflows.** There are specs for what happens *during* operation, but not the concrete step-by-step of adding a new asset to the fleet or offboarding an operator who leaves the company — including what happens to their historical Timeline data (retained, per "everything has a timeline," but the actual process needs to be written down).

**7. Support/help pathway.** If an operator is stuck mid-shift, what's the actual path to help — in-app support chat, a phone number, a fallback? Not glamorous, but a real gap.

## What I'd cut or de-scope from the near-term plan — and why

**1. Multi-company support, at launch.** This is a genuinely good enterprise/contractor feature, but your first customer is a small courier company. Nobody there needs one login spanning multiple companies on day one. I'd move this to v2 rather than build it now — it adds real complexity to auth and permissions for a segment that won't use it yet.

**2. Full NHVR/Chain of Responsibility/fatigue rule engine, at launch.** This is the right long-term bet, but building a fully correct, audit-defensible fatigue/hours engine is a serious undertaking on its own — the kind of thing that needs legal review, not just engineering. For v1, I'd scope compliance down to what's genuinely achievable fast and valuable immediately: document expiry tracking (registration/insurance/roadworthy) and a basic evidence trail from checklists. Land the fatigue-rule engine as a fast-follow once you have real customers and can validate the rules with someone who actually knows NHVR fatigue law cold. Shipping a wrong compliance calculation is worse than not having one yet.

**3. AI Voice, at launch.** It's a great differentiator, but it's also the single riskiest, hardest-to-get-right feature on the list (noisy cab environments, misrecognition, safety implications of a wrong action executing). I'd hold this for v1.x rather than let it block the initial release — Smart Checklists and fault reporting via touch already solve the core problem; voice is the polish layer, not the foundation.

**4. Fleet Graph as a graph-native system, immediately.** I already hedged this in `11-Database/Data_Model.md`, but I'll say it more bluntly here: don't reach for a dedicated graph database on day one. Model relationships relationally with good indexing, prove out the query patterns real customers actually use, and only introduce true graph infrastructure when you have a concrete performance reason to. This is the classic trap of building for the scale you dream of instead of the scale you have.

**5. "Fleet DNA" (the platform learning how each company uniquely operates) — cut from the near-term roadmap entirely.** It sounds compelling but it's vague enough that it risks becoming a permanent "someday" feature that never gets a clear spec. I'd retire it as a named concept and let genuinely useful pieces of the idea (like default checklist templates adapting based on usage patterns) emerge as concrete Fleet Intelligence features later, each with its own real spec — rather than keeping an ill-defined umbrella concept alive.

**6. Owned hardware / branded tablets — don't let this become a distraction.** You've already made the right call (BYO tablets, optional supplier partnership). My only addition: resist any temptation to revisit this before the software business is proven. Hardware distribution deals are slow, capital-intensive, and easy to let eat founder attention that should be on the software.

## The honest bottom line

The repository as built covers the full v1 product surface well. The real risk to the business isn't missing features — it's (a) underestimating how much onboarding/migration and privacy/compliance groundwork sits *before* a customer ever sees a checklist, and (b) over-scoping compliance and AI Voice for launch in a way that delays getting the core replace-paper-and-texts workflow in front of real courier companies. I'd rather you ship the boring core fast and expand from real usage than build every ambitious idea in this repo simultaneously.
