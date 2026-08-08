CREATE TABLE "chat_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"preview_text" text,
	"sha256" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_attachments_chat_created_index" ON "chat_attachments" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_attachments_worker_index" ON "chat_attachments" USING btree ("worker_id");