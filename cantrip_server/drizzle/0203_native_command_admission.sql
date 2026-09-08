CREATE TABLE "native_command_activations" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"generation" text NOT NULL,
	"operation_id" text NOT NULL,
	"execution_lane_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"runtime_generation" text,
	"native_turn_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_command_activations_generation_unique" UNIQUE("generation")
);
--> statement-breakpoint
CREATE TABLE "native_commands" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"operation_generation" text NOT NULL,
	"activation_generation" text,
	"execution_lane_id" text,
	"origin" text NOT NULL,
	"method" text NOT NULL,
	"kind" text NOT NULL,
	"payload_digest" text NOT NULL,
	"protected_payload" jsonb NOT NULL,
	"identity" jsonb NOT NULL,
	"intent" jsonb NOT NULL,
	"reply_identity" jsonb,
	"status" text NOT NULL,
	"rejection_code" text,
	"result_digest" text,
	"protected_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_commands_operation_generation_unique" UNIQUE("operation_generation"),
	CONSTRAINT "native_commands_origin_check" CHECK ("native_commands"."origin" IN ('gui','terminal','autonomous')),
	CONSTRAINT "native_commands_status_check" CHECK ("native_commands"."status" IN ('accepted','dispatched','applied','rejected','uncertain')),
	CONSTRAINT "native_commands_payload_digest_check" CHECK ("native_commands"."payload_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "native_pending_requests" (
	"chat_id" text NOT NULL,
	"runtime_generation" text NOT NULL,
	"native_request_id" text NOT NULL,
	"activation_generation" text NOT NULL,
	"request_method" text NOT NULL,
	"turn_id" text,
	"resolution_operation_id" text,
	CONSTRAINT "native_pending_requests_chat_id_runtime_generation_native_request_id_pk" PRIMARY KEY("chat_id","runtime_generation","native_request_id")
);
--> statement-breakpoint
ALTER TABLE "native_command_activations" ADD CONSTRAINT "native_command_activations_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_command_activations" ADD CONSTRAINT "native_command_activations_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_command_activations" ADD CONSTRAINT "native_command_activations_execution_lane_id_chat_execution_lanes_id_fk" FOREIGN KEY ("execution_lane_id") REFERENCES "public"."chat_execution_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_command_activations" ADD CONSTRAINT "native_command_activations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_commands" ADD CONSTRAINT "native_commands_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_commands" ADD CONSTRAINT "native_commands_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_commands" ADD CONSTRAINT "native_commands_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_commands" ADD CONSTRAINT "native_commands_execution_lane_id_chat_execution_lanes_id_fk" FOREIGN KEY ("execution_lane_id") REFERENCES "public"."chat_execution_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_pending_requests" ADD CONSTRAINT "native_pending_requests_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_pending_requests" ADD CONSTRAINT "native_pending_requests_resolution_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("resolution_operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_commands_chat_created" ON "native_commands" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "native_commands_resolved_reply" ON "native_commands" USING btree ("chat_id",("identity"->>'runtimeGeneration'),("reply_identity"->>'nativeRequestId')) WHERE "native_commands"."reply_identity" IS NOT NULL AND "native_commands"."status" IN ('accepted','dispatched','applied','uncertain');
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "managed_autonomy_stopped" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
ALTER TABLE "native_commands" ADD COLUMN "terminal_result_digest" text, ADD COLUMN "protected_terminal_result" jsonb, ADD COLUMN "terminal_evidence" jsonb, ADD COLUMN "execution_completed_at" timestamp with time zone;

--> statement-breakpoint
ALTER TABLE "native_commands" ADD COLUMN "logical_operation_id" text, ADD COLUMN "previous_operation_id" text;
--> statement-breakpoint
ALTER TABLE "native_command_activations" ADD COLUMN "logical_cancelled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "native_commands" ADD CONSTRAINT "native_commands_logical_operation_fk" FOREIGN KEY ("logical_operation_id") REFERENCES "native_commands"("operation_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "native_commands" ADD CONSTRAINT "native_commands_previous_operation_fk" FOREIGN KEY ("previous_operation_id") REFERENCES "native_commands"("operation_id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "native_commands_previous_operation_unique" ON "native_commands" ("previous_operation_id");
