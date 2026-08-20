import { randomBytes, randomUUID } from "node:crypto";

import type {
  PrivateDisplayLabelOpaque,
  PrivateDisplayLabelRecordKind,
} from "@cantrip/protocol/private-labels";
import type { SurfacePrivateStateOpaque } from "@cantrip/protocol/surface-private-state";

export function protectedDisplayLabelFields(
  recordKind: PrivateDisplayLabelRecordKind,
  id = randomUUID(),
): {
  id: string;
  titleProtection: PrivateDisplayLabelOpaque;
} {
  return {
    id,
    titleProtection: {
      classification: { recordKind },
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
  return protectedDisplayLabelFields("chat", id);
}

export function protectedTerminalFields(id = randomUUID()): {
  id: string;
  titleProtection: PrivateDisplayLabelOpaque;
  stateProtection: SurfacePrivateStateOpaque;
} {
  return {
    ...protectedDisplayLabelFields("terminal", id),
    stateProtection: {
      classification: { recordKind: "terminal-state" },
      protectedState: {
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

export function protectedExplorerFields(id = randomUUID()): {
  id: string;
  titleProtection: PrivateDisplayLabelOpaque;
  stateProtection: SurfacePrivateStateOpaque;
} {
  return {
    ...protectedDisplayLabelFields("explorer", id),
    stateProtection: {
      classification: { recordKind: "explorer-state" },
      protectedState: {
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
