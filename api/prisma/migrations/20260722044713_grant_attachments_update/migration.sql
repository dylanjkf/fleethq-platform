-- 14-Security/Privacy_Data_Protection.md's erasure path needs to tombstone
-- (zero out) an Attachment's bytes in place rather than deleting the row, so
-- ComplianceDocument.fileAttachmentId never dangles. The original
-- add_attachments migration only granted SELECT/INSERT since attachments
-- were write-once until now.
GRANT UPDATE ON attachments TO fleetos_app;
