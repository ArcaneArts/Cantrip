ALTER TABLE "user_sessions" ADD COLUMN "csrf_token_hash" text;
--> statement-breakpoint
UPDATE "user_sessions"
SET "csrf_token_hash" = 'legacy-session-must-reauthenticate',
    "revoked_at" = COALESCE("revoked_at", now()),
    "revoked_reason" = COALESCE("revoked_reason", 'csrf-upgrade');
--> statement-breakpoint
ALTER TABLE "user_sessions" ALTER COLUMN "csrf_token_hash" SET NOT NULL;
