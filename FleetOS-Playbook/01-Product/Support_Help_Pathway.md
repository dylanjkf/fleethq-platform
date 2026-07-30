# Support / Help Pathway

## Purpose
FOUNDER_NOTES.md's #7 gap: "if an operator is stuck mid-shift, what's the actual path to help — in-app support chat, a phone number, a fallback?" Not glamorous, but real — DriverOS shipped Messages, Checklists, and Dispatch without ever answering "what does an operator actually do when something's gone wrong and they need a human, right now." This file answers it using what already exists, plus one small missing piece (a company-configured phone number).

## Scope (v1)
- **Primary path: Messages.** The operator↔office Message thread (already built, already offline-outbox-backed — a message sent with no connectivity queues and sends once it's back) is the first thing DriverOS offers when an operator asks for help. No new chat infrastructure — this is exactly the cross-cutting notifications/messaging surface FOUNDER_NOTES' own #2 gap already covers; Support/Help is a *pathway to* Messages, not a second messaging system.
- **Fallback path: a phone number.** A company sets one support phone number (and optional free-text notes — office hours, an after-hours contact) on their Company profile. Unlike Messages, a `tel:` link works with zero app connectivity and zero dependency on FleetOS's own backend being reachable at all — the actual "I need a human right now, the app itself might be the problem" fallback.
- **No AI Voice, no live chat widget, no third-party helpdesk integration** — all explicitly out of scope per `CLAUDE.md`'s "what NOT to build right now" and `09-AI/AI_Voice.md`'s own deferred status. This file is about giving an operator a clear, discoverable path to a human, not automating the human away.

## Requirements
- A dedicated, always-reachable "Get help" entry point in DriverOS (not buried inside another screen) — an operator under stress shouldn't have to remember which menu Messages lives under.
- The support phone number (and notes) must be readable by every authenticated user in the company regardless of their role's permissions — a Driver role with no `companies:view` must still be able to see it. This is a deliberate exception to "permissions are granular" (`14-Security/Permissions_Model.md`): a support contact is closer to "your own account's context" (like notification preferences) than a company-settings capability.
- Editing the support phone/notes stays gated on `companies:edit`, same as the rest of the Company profile.

## Edge cases
- **No support phone configured yet**: the Get Help screen still works — it shows the Messages path and a plain "no phone number set up yet" note instead of a broken/empty call button.
- **Operator has no linked DriverOS login at all** (office-only staff): not applicable — this is a DriverOS-side screen; office staff have their own escalation path (talking to a colleague in person, or FleetHQ's own in-app Messages view) that this file doesn't need to invent a parallel path for.

## Acceptance criteria
- From DriverOS's Today screen, an operator can reach a "Get help" screen in one tap.
- That screen offers "Message the office" (working offline too) and, if configured, "Call {number}" via a real `tel:` link.
- A company admin can set/change the support phone and notes from FleetHQ's existing Company profile screen.

## Future expansion notes
- A persistent bottom-nav "Help" affordance (rather than a header link on the Today screen only) is worth revisiting once DriverOS has more than a handful of screens and a real navigation shell.
- If real usage shows operators need help mid-*something-else* (mid-checklist, mid-delivery-stop), consider surfacing the same "Get help" entry point from those screens too, not just Today.

## Implementation notes (`apps/api` + `apps/driveros` + `apps/fleethq`)
- `Company.supportPhone` / `Company.supportNotes` (both nullable strings) — `PATCH /v1/companies/me` (`companies:edit`) sets them; `GET /v1/companies/me/support` (no permission gate) reads just that slice.
- DriverOS's new `/help` route: "Message the office" button to `/messages`, plus a `tel:` link when a support phone is set. Reachable via a "Help" link in the Today screen's header, alongside Alerts/Messages/My Documents.
- FleetHQ's existing Company profile tab (`CompanyTab.tsx`) gained two new fields in the same form as the company name.
