CREATE TABLE "native_runtime_handoffs" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"phase" text NOT NULL,
	"source" jsonb NOT NULL,
	"target_model_route_id" text NOT NULL,
	"target_provider_account_id" text,
	"prepared" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_runtime_handoffs_phase_check" CHECK ("native_runtime_handoffs"."phase" IN ('preparing','prepared','committed','completed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "native_runtime_handoffs" ADD CONSTRAINT "native_runtime_handoffs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_runtime_handoffs" ADD CONSTRAINT "native_runtime_handoffs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_runtime_handoffs" ADD CONSTRAINT "native_runtime_handoffs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_runtime_handoffs_active_chat" ON "native_runtime_handoffs" USING btree ("chat_id") WHERE "native_runtime_handoffs"."phase" NOT IN ('completed', 'cancelled');--> statement-breakpoint
CREATE INDEX "native_runtime_handoffs_chat" ON "native_runtime_handoffs" USING btree ("chat_id");