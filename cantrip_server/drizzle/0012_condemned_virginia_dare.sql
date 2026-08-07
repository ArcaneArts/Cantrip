CREATE TABLE "queued_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"text" text NOT NULL,
	"model_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD CONSTRAINT "queued_prompts_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD CONSTRAINT "queued_prompts_model_id_model_profiles_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "queued_prompts_chat_idempotency_unique" ON "queued_prompts" USING btree ("chat_id","idempotency_key");