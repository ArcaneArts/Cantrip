CREATE TABLE "managed_queue_claims" (
	"request_operation_id" text,
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"prompt_id" text NOT NULL,
	"awaiting_goal" boolean DEFAULT false NOT NULL,
	"goal_epoch" text,
	"goal_operation_id" text,
	"goal_operation_generation" text,
	"prompt_revision" integer NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"operation_id" text,
	"operation_generation" text,
	"native_turn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_queue_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"source_digest" text NOT NULL,
	"chat_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"protected_source" jsonb NOT NULL,
	"native_item_id" text NOT NULL,
	"identity" jsonb NOT NULL,
	"runner_generation" text NOT NULL,
	"prompt_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_queue_states" (
	"notified_revision" integer DEFAULT -1 NOT NULL,
	"notification_due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chat_id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_logical_completions" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"root_operation_id" text PRIMARY KEY NOT NULL,
	"root_operation_generation" text NOT NULL,
	"owner_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_commands" ADD COLUMN "queue_result" jsonb;--> statement-breakpoint
ALTER TABLE "native_commands" ADD COLUMN "logical_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_queue_claims" ADD CONSTRAINT "managed_queue_claims_request_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("request_operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_queue_claims" ADD CONSTRAINT "managed_queue_claims_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_queue_claims" ADD CONSTRAINT "managed_queue_claims_prompt_id_queued_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."queued_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_queue_claims" ADD CONSTRAINT "managed_queue_claims_goal_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("goal_operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_queue_claims" ADD CONSTRAINT "managed_queue_claims_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_queue_imports" ADD CONSTRAINT "managed_queue_imports_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_queue_imports" ADD CONSTRAINT "managed_queue_imports_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_queue_imports" ADD CONSTRAINT "managed_queue_imports_prompt_id_queued_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."queued_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_queue_states" ADD CONSTRAINT "managed_queue_states_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_logical_completions" ADD CONSTRAINT "native_logical_completions_root_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("root_operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_logical_completions" ADD CONSTRAINT "native_logical_completions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_logical_completions" ADD CONSTRAINT "native_logical_completions_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_logical_completions" ADD CONSTRAINT "native_logical_completions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_queue_claims_live_prompt" ON "managed_queue_claims" USING btree ("prompt_id") WHERE "managed_queue_claims"."status" IN ('claimed','accepted','dispatched','uncertain');--> statement-breakpoint
CREATE UNIQUE INDEX "managed_queue_imports_source_unique" ON "managed_queue_imports" USING btree ("source_key","source_digest");
--> statement-breakpoint
ALTER TABLE "native_commands" ADD COLUMN "logical_client_message_id" text;
