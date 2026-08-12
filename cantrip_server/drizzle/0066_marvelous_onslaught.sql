CREATE TABLE "mobile_sign_in_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"created_by_session_id" text,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_sessions" DROP CONSTRAINT "user_sessions_auth_method_check";--> statement-breakpoint
ALTER TABLE "mobile_sign_in_grants" ADD CONSTRAINT "mobile_sign_in_grants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_sign_in_grants" ADD CONSTRAINT "mobile_sign_in_grants_created_by_session_id_user_sessions_id_fk" FOREIGN KEY ("created_by_session_id") REFERENCES "public"."user_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_sign_in_grants_hash_unique" ON "mobile_sign_in_grants" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "mobile_sign_in_grants_owner_expiry_index" ON "mobile_sign_in_grants" USING btree ("owner_id","expires_at");--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_auth_method_check" CHECK ("user_sessions"."auth_method" IN ('password', 'account-password', 'mobile-qr'));