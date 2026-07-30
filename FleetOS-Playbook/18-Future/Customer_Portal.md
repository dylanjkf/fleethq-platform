# Future Direction: Customer-Facing Portal

## Status
Explicitly out of scope for the current build. FleetOS is fleet-internal software; this document exists so the idea isn't lost, not to greenlight building it now.

## What it could eventually include
Real-time GPS tracking links for customers, operator arrival estimates, operator/asset photos on approach, digital signature and photo proof-of-delivery sharing, live chat with dispatch, delay notifications, invoice visibility.

## Why it's deliberately deferred
This is a genuinely different product with different data-sharing, privacy, and support obligations than internal fleet software. Building it prematurely risks two failure modes: baking customer-facing data-sharing assumptions into the core platform before they're needed (violating the "fleet-internal only" scope decision), or under-investing in it and shipping something that undermines trust in customer-facing tracking generally.

## Preconditions before this should be built
- Core FleetOS (DriverOS + FleetHQ + Fleet Intelligence) proven with real courier customers.
- A deliberate decision that this is a new product surface, with its own privacy/consent model, rather than a checkbox added to existing jobs.
