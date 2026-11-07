import { managedQueueClaimSchema, queuedPromptSchema } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PromptQueue } from "./prompt-queue";

describe("prompt queue rejection recovery", () => {
  it.each(["dispatched", "uncertain", "rejected"] as const)(
    "renders %s with truthful retry and action availability",
    (status) => {
      const now = "2026-11-07T12:00:00.000Z";
      const prompt = queuedPromptSchema.parse({
        id: "prompt",
        revision: 0,
        chatId: "chat",
        text: "Make tasks",
        modelId: "model",
        worktreeId: null,
        position: 0,
        frozen: false,
        createdAt: now,
        updatedAt: now,
      });
      const claim = managedQueueClaimSchema.parse({
        id: "claim",
        chatId: "chat",
        promptId: prompt.id,
        promptRevision: 0,
        status,
        operationId: "operation",
        operationGeneration: "generation",
        nativeTurnId: null,
        createdAt: now,
      });
      const markup = renderToStaticMarkup(
        <PromptQueue
          disabled={false}
          editingPromptId={null}
          executing={false}
          prompts={[prompt]}
          claims={[claim]}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          onFreeze={vi.fn()}
          onReorder={vi.fn()}
          onSteer={vi.fn()}
        />,
      );
      const buttons = markup.match(/<button\b[^>]*>/g)!;
      const start = buttons.find((tag) =>
        tag.includes('title="Start this queued prompt"'),
      )!;
      const actions = buttons.find((tag) =>
        tag.includes('aria-haspopup="menu"'),
      )!;
      expect(start).toBeDefined();
      expect(actions).toBeDefined();
      expect(start.includes("disabled=")).toBe(status !== "rejected");
      expect(actions.includes("disabled=")).toBe(status !== "rejected");
      expect(markup).toContain(
        status === "rejected"
          ? "Start failed"
          : status === "uncertain"
            ? "Start unconfirmed"
            : "Awaiting confirmation",
      );
      if (status === "rejected") expect(markup).toContain("Retry");
    },
  );
});
