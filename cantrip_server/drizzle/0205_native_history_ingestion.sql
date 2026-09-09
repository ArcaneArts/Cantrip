CREATE TABLE "native_history_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"model_route_id" text,
	"provider_account_id" text,
	"created_from_operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_history_bindings" ADD CONSTRAINT "native_history_bindings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_bindings" ADD CONSTRAINT "native_history_bindings_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_bindings" ADD CONSTRAINT "native_history_bindings_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_bindings" ADD CONSTRAINT "native_history_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_bindings" ADD CONSTRAINT "native_history_bindings_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_history_bindings_owned_thread" ON "native_history_bindings" USING btree ("owner_id","worker_id","chat_id","thread_id");--> statement-breakpoint
CREATE INDEX "native_history_bindings_worker_chat" ON "native_history_bindings" USING btree ("worker_id","chat_id");
--> statement-breakpoint
CREATE TABLE "native_history_publications" (
	"commit_id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_history_receipts" (
	"commit_id" text PRIMARY KEY NOT NULL,
	"stream_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"record_id" text NOT NULL,
	"digest" text NOT NULL,
	"payload_digest" text NOT NULL,
	"previous_digest" text,
	"protected_batch" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_history_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"acknowledged_sequence" bigint DEFAULT 0 NOT NULL,
	"acknowledged_digest" text,
	CONSTRAINT "native_history_streams_binding_id_unique" UNIQUE("binding_id")
);
--> statement-breakpoint
ALTER TABLE "native_history_publications" ADD CONSTRAINT "native_history_publications_commit_id_native_history_receipts_commit_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."native_history_receipts"("commit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_publications" ADD CONSTRAINT "native_history_publications_binding_id_native_history_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."native_history_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_receipts" ADD CONSTRAINT "native_history_receipts_stream_id_native_history_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."native_history_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_streams" ADD CONSTRAINT "native_history_streams_binding_id_native_history_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."native_history_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_history_publications_due" ON "native_history_publications" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "native_history_receipts_sequence" ON "native_history_receipts" USING btree ("stream_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "native_history_receipts_record" ON "native_history_receipts" USING btree ("stream_id","record_id");
--> statement-breakpoint
CREATE TABLE "native_history_turns" (
	"binding_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"ordinal" bigint NOT NULL,
	"status" text NOT NULL,
	"started_at_ms" double precision,
	"completed_at_ms" double precision,
	"metadata" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	CONSTRAINT "native_history_turns_binding_id_turn_id_pk" PRIMARY KEY("binding_id","turn_id"),
	CONSTRAINT "native_history_turns_revision_check" CHECK ("native_history_turns"."revision" > 0 AND "native_history_turns"."revision" <= 9007199254740991),
	CONSTRAINT "native_history_turns_ordinal_check" CHECK ("native_history_turns"."ordinal" >= 0 AND "native_history_turns"."ordinal" <= 9007199254740991),
	CONSTRAINT "native_history_turns_status_check" CHECK ("native_history_turns"."status" IN ('inProgress','completed','failed','interrupted')),
	CONSTRAINT "native_history_turns_digest_check" CHECK ("native_history_turns"."payload_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "native_history_turns" ADD CONSTRAINT "native_history_turns_binding_id_native_history_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."native_history_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_history_turns_order" ON "native_history_turns" USING btree ("binding_id","ordinal","turn_id");
--> statement-breakpoint
CREATE TABLE "native_command_turns" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"runtime_generation" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_history_items" (
	"key" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"item_id" text NOT NULL,
	"component" text NOT NULL,
	"identity_kind" text NOT NULL,
	"message_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"alias_operation_id" text,
	"preserved_input" jsonb,
	CONSTRAINT "native_history_items_kind_check" CHECK ("native_history_items"."identity_kind" IN ('canonical','legacy')),
	CONSTRAINT "native_history_items_alias_check" CHECK (("native_history_items"."alias_operation_id" IS NULL) = ("native_history_items"."preserved_input" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "native_command_turns" ADD CONSTRAINT "native_command_turns_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_command_turns" ADD CONSTRAINT "native_command_turns_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD CONSTRAINT "native_history_items_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD CONSTRAINT "native_history_items_alias_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("alias_operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_command_turns_native_identity" ON "native_command_turns" USING btree ("chat_id","thread_id","turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "native_history_items_input_alias" ON "native_history_items" USING btree ("alias_operation_id");--> statement-breakpoint
CREATE INDEX "native_history_items_message" ON "native_history_items" USING btree ("chat_id","message_id");
--> statement-breakpoint
ALTER TABLE "native_history_items" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD COLUMN "state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD COLUMN "payload_digest" text;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD COLUMN "turn_ordinal" bigint;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD COLUMN "item_ordinal" bigint;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD COLUMN "component_ordinal" bigint;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD CONSTRAINT "native_history_items_revision_check" CHECK ("native_history_items"."revision" >= 0 AND "native_history_items"."revision" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "native_history_items" ADD CONSTRAINT "native_history_items_state_check" CHECK ("native_history_items"."state" IN ('started','completed','unknown'));--> statement-breakpoint
ALTER TABLE "native_history_items" ADD CONSTRAINT "native_history_items_content_check" CHECK (("native_history_items"."revision" = 0 AND "native_history_items"."payload_digest" IS NULL AND "native_history_items"."turn_ordinal" IS NULL AND "native_history_items"."item_ordinal" IS NULL AND "native_history_items"."component_ordinal" IS NULL) OR ("native_history_items"."revision" > 0 AND "native_history_items"."payload_digest" IS NOT NULL AND "native_history_items"."turn_ordinal" IS NOT NULL AND "native_history_items"."item_ordinal" IS NOT NULL AND "native_history_items"."component_ordinal" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "native_history_items" DROP CONSTRAINT "native_history_items_alias_check";--> statement-breakpoint
ALTER TABLE "native_history_items" ADD COLUMN "output_operation_id" text;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD CONSTRAINT "native_history_items_output_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("output_operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD CONSTRAINT "native_history_items_alias_check" CHECK ((("native_history_items"."alias_operation_id" IS NULL) = ("native_history_items"."preserved_input" IS NULL)) AND ("native_history_items"."alias_operation_id" IS NULL OR "native_history_items"."output_operation_id" IS NULL));
--> statement-breakpoint
CREATE TABLE "managed_queue_input_snapshots" (
	"claim_id" text PRIMARY KEY NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt_revision" integer NOT NULL,
	"protected_input" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_history_items" DROP CONSTRAINT "native_history_items_alias_check";--> statement-breakpoint
ALTER TABLE "native_history_items" ADD COLUMN "alias_claim_id" text;--> statement-breakpoint
ALTER TABLE "managed_queue_input_snapshots" ADD CONSTRAINT "managed_queue_input_snapshots_claim_id_managed_queue_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."managed_queue_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_history_items" ADD CONSTRAINT "native_history_items_alias_claim_id_managed_queue_claims_id_fk" FOREIGN KEY ("alias_claim_id") REFERENCES "public"."managed_queue_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_history_items_queue_alias" ON "native_history_items" USING btree ("alias_claim_id");--> statement-breakpoint
ALTER TABLE "native_history_items" ADD CONSTRAINT "native_history_items_alias_check" CHECK ((("native_history_items"."alias_operation_id" IS NULL) = ("native_history_items"."preserved_input" IS NULL)) AND ("native_history_items"."alias_operation_id" IS NULL OR "native_history_items"."output_operation_id" IS NULL) AND ("native_history_items"."alias_claim_id" IS NULL OR "native_history_items"."alias_operation_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "native_history_items" ADD COLUMN "protected_evidence" jsonb;

--> statement-breakpoint
CREATE TABLE "native_history_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"record_id" text NOT NULL,
	"decision" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_history_rejections" ADD CONSTRAINT "native_history_rejections_binding_id_native_history_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."native_history_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_history_rejections_record" ON "native_history_rejections" USING btree ("binding_id","record_id");
