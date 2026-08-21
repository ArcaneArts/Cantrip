-- Pre-release destructive cutover: legacy attachment metadata and relocation
-- snapshots contain server-readable filenames, MIME types, previews, and
-- digests. Existing development data is intentionally discarded instead of
-- retaining a plaintext compatibility path.
DELETE FROM "chat_relocation_snapshots";--> statement-breakpoint
DELETE FROM "chat_relocation_jobs";--> statement-breakpoint
DELETE FROM "chat_attachment_replicas";--> statement-breakpoint
DELETE FROM "chat_attachments";--> statement-breakpoint
UPDATE "queued_prompts" SET "attachments" = '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD COLUMN "protected_metadata" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_attachments" DROP COLUMN "file_name";--> statement-breakpoint
ALTER TABLE "chat_attachments" DROP COLUMN "mime_type";--> statement-breakpoint
ALTER TABLE "chat_attachments" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "chat_attachments" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "chat_attachments" DROP COLUMN "preview_text";--> statement-breakpoint
ALTER TABLE "chat_attachments" DROP COLUMN "sha256";--> statement-breakpoint
ALTER TABLE "chat_attachments" DROP COLUMN "error";
