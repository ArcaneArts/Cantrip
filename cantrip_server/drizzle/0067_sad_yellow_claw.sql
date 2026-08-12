CREATE TABLE "account_license_whitelist" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_license_whitelist" ADD CONSTRAINT "account_license_whitelist_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_license_whitelist_normalized_email_unique" ON "account_license_whitelist" USING btree ("normalized_email");--> statement-breakpoint
CREATE INDEX "account_license_whitelist_created_at_index" ON "account_license_whitelist" USING btree ("created_at");