-- Configurable, multi-drop-aware Proof of Delivery (docs/design/Configurable_POD.md)

-- 1. A DELIVERY form-template context: a template with this context IS the
--    tenant's delivery-confirmation evidence set.
ALTER TYPE "FormTargetContext" ADD VALUE 'DELIVERY';

-- 2. The one shared evidence submission per confirmed stop.
ALTER TABLE "job_stops" ADD COLUMN "pod_submission_id" UUID;
ALTER TABLE "job_stops" ADD CONSTRAINT "job_stops_pod_submission_id_fkey"
  FOREIGN KEY ("pod_submission_id") REFERENCES "form_submissions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Per-parcel drop completion, sharing the stop's evidence submission.
ALTER TABLE "stop_parcels" ADD COLUMN "delivered_at" TIMESTAMP(3);
ALTER TABLE "stop_parcels" ADD COLUMN "pod_submission_id" UUID;
ALTER TABLE "stop_parcels" ADD CONSTRAINT "stop_parcels_pod_submission_id_fkey"
  FOREIGN KEY ("pod_submission_id") REFERENCES "form_submissions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
