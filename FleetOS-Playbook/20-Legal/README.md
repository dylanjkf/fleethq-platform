# Legal document drafts

## STATUS: DRAFTS — PENDING AUSTRALIAN LEGAL REVIEW. NOT YET ENFORCEABLE.

Every document in this folder is a **good-faith working draft prepared by the engineering team, not a lawyer**, at the founder's explicit request to "prepare lawyer-ready drafts now." None of them has been reviewed by a qualified Australian lawyer, and **none may be presented to a customer, published, linked from the product, or relied on in any contract until that review is complete.**

These drafts exist to:
- give a reviewing lawyer a concrete, product-accurate starting point (they describe how FleetOS actually handles data, billing, and multi-tenancy — the technical facts a generic template wouldn't know), and
- surface, for the founder, exactly which commercial and legal decisions still need a human answer (marked inline as **[DECISION NEEDED: …]** and **[LAWYER TO CONFIRM: …]**).

They are deliberately written to be edited down and corrected, not adopted as-is.

## Documents
- `Terms_of_Service.DRAFT.md` — the subscription/usage agreement between FleetOS and its customer (the transport company).
- `Privacy_Policy.DRAFT.md` — how FleetOS (as the software provider) handles personal information, aligned to `14-Security/Privacy_Data_Protection.md`'s controller/processor split and the Australian Privacy Act 1988 / Australian Privacy Principles.
- `Data_Processing_Addendum.DRAFT.md` — the processor-side data-handling terms a business customer will expect, covering what FleetOS does with the *operator* personal data its customer controls.

## What a lawyer still needs to decide or confirm (summary)
- The governing-law jurisdiction and dispute-resolution venue (drafted as an Australian state, **[DECISION NEEDED]** which).
- The actual company legal entity name, ABN/ACN, and registered address (placeholders throughout).
- Liability caps, warranty disclaimers, and indemnity scope — drafted conservatively but these are commercial/legal calls.
- Whether FleetOS uses any sub-processors (hosting is AWS ap-southeast-2 per `infra/`; that's the main one) and how they're disclosed.
- Data breach notification commitments and timelines (Notifiable Data Breaches scheme under the Privacy Act).
- Refund / cancellation terms beyond what Stripe's flow mechanically allows.
