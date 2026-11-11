-- Preserve a receipt's final opaque answer when earlier streamed updates arrive late.
ALTER TABLE chat_messages ADD COLUMN task_output_finalized boolean NOT NULL DEFAULT false;
