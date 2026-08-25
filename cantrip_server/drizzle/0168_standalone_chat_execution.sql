CREATE UNIQUE INDEX "standalone_chat_roots_id_chat_unique" ON "standalone_chat_roots" USING btree ("id", "chat_id");--> statement-breakpoint

ALTER TABLE "chat_messages" ADD COLUMN "scratch_root_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "worktree_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_scratch_identity_fk" FOREIGN KEY ("scratch_root_id", "chat_id") REFERENCES "public"."standalone_chat_roots"("id", "chat_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_execution_root_check" CHECK (num_nonnulls("chat_messages"."worktree_id", "chat_messages"."scratch_root_id") = 1);
