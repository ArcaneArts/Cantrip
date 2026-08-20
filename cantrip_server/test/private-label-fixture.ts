import { randomBytes, randomUUID } from "node:crypto";

import type { PrivateDisplayLabelOpaque } from "@cantrip/protocol/private-labels";

export function protectedProjectFields(id = randomUUID()): {
  id: string;
  nameProtection: PrivateDisplayLabelOpaque;
} {
  return {
    id,
    nameProtection: {
      classification: { recordKind: "project" },
      protectedLabel: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: randomBytes(12).toString("base64url"),
          ciphertext: randomBytes(32).toString("base64url"),
        },
      },
    },
  };
}

export function protectedChatFields(id = randomUUID()): {
  id: string;
  titleProtection: PrivateDisplayLabelOpaque;
} {
  return {
    id,
    titleProtection: {
      classification: { recordKind: "chat" },
      protectedLabel: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: randomBytes(12).toString("base64url"),
          ciphertext: randomBytes(32).toString("base64url"),
        },
      },
    },
  };
}
