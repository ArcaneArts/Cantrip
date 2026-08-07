ALTER TABLE "terminals" ADD COLUMN "linked_chat_id" text;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_linked_chat_id_chats_id_fk" FOREIGN KEY ("linked_chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_linked_chat_id_unique" UNIQUE("linked_chat_id");