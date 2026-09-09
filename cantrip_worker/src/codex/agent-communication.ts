export interface InterAgentCommunicationItem {
  type: "interAgentCommunication";
  id: string;
  author: string;
  recipient: string;
  otherRecipients: string[];
  text: string | null;
  encryptedContent: string | null;
  triggerTurn: boolean;
}

/** Keep live and retained history presentation consistent. Opaque native
 * payloads must never become display text, even if a text field is also set. */
export function describeAgentCommunication(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.author !== "string" ||
    typeof body.recipient !== "string" ||
    !Array.isArray(body.otherRecipients) ||
    !body.otherRecipients.every((recipient) => typeof recipient === "string") ||
    typeof body.triggerTurn !== "boolean" ||
    (body.text !== null && typeof body.text !== "string") ||
    (body.encryptedContent !== null &&
      typeof body.encryptedContent !== "string")
  )
    return null;
  const encrypted = body.encryptedContent !== null;
  return {
    title: `${body.triggerTurn ? "Agent task" : "Agent message"} · ${body.author} → ${[body.recipient, ...body.otherRecipients].join(", ")}`,
    details: encrypted ? null : body.text,
    unavailable: encrypted
      ? "encrypted-agent-communication"
      : body.text === null
        ? "missing-agent-communication-text"
        : null,
  };
}
