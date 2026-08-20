DELETE FROM "policies";--> statement-breakpoint
UPDATE "policy_owner_states"
SET "bootstrap_version" = 0,
    "collection_version" = "collection_version" + 1,
    "updated_at" = now();--> statement-breakpoint
ALTER TABLE "policies" DROP CONSTRAINT "policies_key_length_check";--> statement-breakpoint
ALTER TABLE "policies" DROP CONSTRAINT "policies_key_format_check";--> statement-breakpoint
ALTER TABLE "policies" DROP CONSTRAINT "policies_name_length_check";--> statement-breakpoint
ALTER TABLE "policies" DROP CONSTRAINT "policies_summary_length_check";--> statement-breakpoint
ALTER TABLE "policies" DROP CONSTRAINT "policies_body_length_check";--> statement-breakpoint
DROP INDEX "policies_owner_key_unique";--> statement-breakpoint
DROP INDEX "policies_owner_position_index";--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "key_blind_index" text NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "protected_summary" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "protected_body" jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "policies_owner_key_blind_unique" ON "policies" USING btree ("owner_id","key_blind_index");--> statement-breakpoint
CREATE INDEX "policies_owner_position_index" ON "policies" USING btree ("owner_id","position");--> statement-breakpoint
ALTER TABLE "policies" DROP COLUMN "key";--> statement-breakpoint
ALTER TABLE "policies" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "policies" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "policies" DROP COLUMN "body_markdown";--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_key_blind_index_length_check" CHECK (length("policies"."key_blind_index") = 43);
