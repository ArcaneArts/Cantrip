import { z } from "zod";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import {
  browserPrivateStateOpaqueSchema,
  remoteDesktopPrivateInventoryOpaqueSchema,
  remoteDesktopPrivateStateOpaqueSchema,
} from "./surface-private-state.js";
import {
  remoteSurfaceProtocolVersionSchema,
  remoteSurfaceKindSchema,
  remoteSurfaceTransportSchema,
  remoteSurfaceStatusSchema,
  remoteSurfaceChannelSchema,
  remoteSurfaceWebRtcConfigurationSchema,
} from "./runtime-capabilities.js";
import { browserHttpUrlSchema } from "./browser-surfaces.js";
import { remoteDesktopApplicationIconKeySchema } from "./remote-desktops.js";

export const remoteSurfaceConfigurationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("browser"),
    profileId: z.string().trim().min(1).max(200).nullable().default(null),
  }),
  z
    .object({
      kind: z.literal("desktop"),
    })
    .strict(),
]);

export const remoteSurfaceCreateSchema = z.object({
  workerId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  configuration: remoteSurfaceConfigurationSchema,
});

export const encryptedRemoteSurfaceCreateSchema = remoteSurfaceCreateSchema
  .omit({ title: true })
  .extend({
    id: z.string().uuid(),
    stateProtection: z
      .union([
        browserPrivateStateOpaqueSchema,
        remoteDesktopPrivateStateOpaqueSchema,
      ])
      .optional(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.titleProtection.classification.recordKind !== "remote-surface") {
      context.addIssue({
        code: "custom",
        message: "Remote Surface title classification must be remote-surface.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    const expectedStateKind =
      input.configuration.kind === "browser"
        ? "browser-state"
        : "remote-desktop-state";
    if (
      input.stateProtection?.classification.recordKind !== expectedStateKind
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote Surface protected state must match its kind.",
        path: ["stateProtection"],
      });
    }
  });

export const remoteSurfaceUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    configuration: remoteSurfaceConfigurationSchema.optional(),
    preferredTransport: remoteSurfaceTransportSchema.optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.configuration !== undefined ||
      input.preferredTransport !== undefined,
    { message: "At least one remote surface field is required." },
  );

export const encryptedRemoteSurfaceUpdateSchema = z
  .object({
    expectedStateRevision: z.number().int().positive().safe().optional(),
    titleProtection: privateDisplayLabelOpaqueSchema.optional(),
    configuration: remoteSurfaceConfigurationSchema.optional(),
    preferredTransport: remoteSurfaceTransportSchema.optional(),
    stateProtection: z
      .union([
        browserPrivateStateOpaqueSchema,
        remoteDesktopPrivateStateOpaqueSchema,
      ])
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.titleProtection === undefined &&
      input.configuration === undefined &&
      input.preferredTransport === undefined &&
      input.stateProtection === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one remote surface field is required.",
      });
    }
    if (
      (input.stateProtection === undefined) !==
      (input.expectedStateRevision === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote Surface state updates require an expected revision.",
        path: ["expectedStateRevision"],
      });
    }
    if (
      input.titleProtection &&
      input.titleProtection.classification.recordKind !== "remote-surface"
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote Surface title classification must be remote-surface.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

const remoteSurfaceSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  workerId: z.string().min(1),
  kind: remoteSurfaceKindSchema,
  status: remoteSurfaceStatusSchema,
  preferredTransport: remoteSurfaceTransportSchema,
  configuration: remoteSurfaceConfigurationSchema,
  stateRevision: z.number().int().positive().safe().nullable(),
  lastError: z.string().nullable(),
  lastConnectedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const remoteSurfaceSummarySchema = remoteSurfaceSummaryBaseSchema.extend(
  {
    title: z.string().min(1).max(200),
    url: browserHttpUrlSchema.nullable(),
  },
);

export const remoteSurfaceWireSummarySchema = remoteSurfaceSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: z
      .union([
        browserPrivateStateOpaqueSchema,
        remoteDesktopPrivateStateOpaqueSchema,
      ])
      .nullable(),
  })
  .superRefine((surface, context) => {
    const recordKind = surface.titleProtection.classification.recordKind;
    if (
      recordKind !== "remote-surface" &&
      !(surface.kind === "browser" && recordKind === "browser") &&
      !(surface.kind === "desktop" && recordKind === "project-view")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Remote Surface title classification must match its canonical owner.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    const expectedRecordKind =
      surface.kind === "browser" ? "browser-state" : "remote-desktop-state";
    if (
      surface.stateProtection?.classification.recordKind !==
        expectedRecordKind ||
      surface.stateRevision === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote Surfaces require protected state matching their kind.",
        path: ["stateProtection"],
      });
    }
  });

export const remoteSurfaceListSchema = z.array(remoteSurfaceSummarySchema);
export const remoteSurfaceWireListSchema = z.array(
  remoteSurfaceWireSummarySchema,
);

export const remoteSurfaceViewportSchema = z.object({
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  devicePixelRatio: z.number().min(0.25).max(8),
});

export const desktopStreamSettingsSchema = z.object({
  targetFps: z.number().int().min(1).max(60),
  quality: z.enum(["adaptive", "data-saver", "balanced", "sharp"]),
});

export const remoteSurfaceConnectionMessageSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("ready"),
      surfaceId: z.string().min(1),
      attachmentId: z.string().min(1),
      transport: remoteSurfaceTransportSchema,
      webrtc: remoteSurfaceWebRtcConfigurationSchema.nullable().default(null),
    }),
    z.object({
      type: z.literal("error"),
      message: z.string().min(1),
      recoverable: z.boolean(),
    }),
  ],
);

export const remoteSurfaceAttachResultSchema = z.object({
  accepted: z.literal(true),
  transport: remoteSurfaceTransportSchema,
});

export const remoteSurfaceControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resize"),
    viewport: remoteSurfaceViewportSchema,
  }),
  z.object({ type: z.literal("suspend") }),
  z.object({ type: z.literal("resume") }),
]);

export const remoteDesktopProbeResultSchema = z.object({
  available: z.boolean(),
  message: z.string().max(2_048).nullable(),
});

export const remoteDesktopApplicationIconSchema = z.object({
  key: remoteDesktopApplicationIconKeySchema,
  mimeType: z.literal("image/png"),
  data: z.string().max(180_000).nullable(),
});

export const remoteDesktopClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("viewport"),
    viewport: remoteSurfaceViewportSchema,
  }),
  z.object({
    type: z.literal("pointer"),
    event: z.enum(["move", "down", "up", "wheel"]),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z
      .enum(["none", "left", "middle", "right", "back", "forward"])
      .default("none"),
    buttons: z.number().int().nonnegative().max(31).default(0),
    clickCount: z.number().int().min(0).max(3).default(0),
    deltaX: z.number().finite().default(0),
    deltaY: z.number().finite().default(0),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({
    type: z.literal("key"),
    event: z.enum(["down", "up"]),
    key: z.string().max(100),
    code: z.string().max(100),
    text: z.string().max(10).default(""),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({ type: z.literal("focus") }),
  z.object({ type: z.literal("refresh-targets") }),
  z.object({
    type: z.literal("request-target-icons"),
    keys: z.array(remoteDesktopApplicationIconKeySchema).min(1).max(64),
  }),
  z.object({
    type: z.literal("clipboard"),
    operation: z.enum(["copy", "paste-text"]),
    text: z.string().max(1_000_000).default(""),
  }),
  z.object({
    type: z.literal("stream-feedback"),
    intervalMs: z.number().int().min(250).max(10_000),
    receivedFrames: z.number().int().nonnegative().max(1_000),
    renderedFrames: z.number().int().nonnegative().max(1_000),
    droppedFrames: z.number().int().nonnegative().max(1_000),
    averageDecodeMs: z.number().finite().nonnegative().max(10_000),
  }),
]);

export const remoteDesktopServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("desktop-state"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    status: z.enum(["ready", "launching", "suspended", "error"]),
    message: z.string().max(2_048).nullable(),
    stream: z
      .object({
        backend: z.enum(["native", "compatibility"]),
        targetFps: z.number().int().min(1).max(60),
        observedFps: z.number().finite().nonnegative().max(240),
        quality: z.number().int().min(1).max(100),
        encodedWidth: z.number().int().positive(),
      })
      .nullable()
      .default(null),
  }),
  z
    .object({
      type: z.literal("desktop-targets"),
      operationId: z.string().uuid(),
      stateProtection: remoteDesktopPrivateInventoryOpaqueSchema,
      monitorCount: z.number().int().nonnegative().max(64),
      windowCount: z.number().int().nonnegative().max(2_000),
    })
    .strict(),
  z.object({
    type: z.literal("desktop-target-icons"),
    icons: z.array(remoteDesktopApplicationIconSchema).max(64),
  }),
  z.object({
    type: z.literal("desktop-clipboard"),
    text: z.string().max(1_000_000),
  }),
]);

export const remoteBrowserClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    operationId: z.string().uuid(),
    stateProtection: browserPrivateStateOpaqueSchema,
  }),
  z.object({
    type: z.literal("history"),
    delta: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("stop") }),
  z.object({
    type: z.literal("viewport"),
    viewport: remoteSurfaceViewportSchema,
  }),
  z.object({
    type: z.literal("pointer"),
    event: z.enum(["move", "down", "up", "wheel"]),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z
      .enum(["none", "left", "middle", "right", "back", "forward"])
      .default("none"),
    buttons: z.number().int().nonnegative().max(31).default(0),
    clickCount: z.number().int().min(0).max(3).default(0),
    deltaX: z.number().finite().default(0),
    deltaY: z.number().finite().default(0),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({
    type: z.literal("key"),
    event: z.enum(["down", "up"]),
    key: z.string().max(100),
    code: z.string().max(100),
    text: z.string().max(10).default(""),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({ type: z.literal("focus") }),
  z.object({
    type: z.literal("touch"),
    event: z.enum(["start", "move", "end", "cancel"]),
    points: z
      .array(
        z.object({
          id: z.number().int().nonnegative(),
          x: z.number().finite().nonnegative(),
          y: z.number().finite().nonnegative(),
          radiusX: z.number().finite().positive().default(1),
          radiusY: z.number().finite().positive().default(1),
          force: z.number().finite().min(0).max(1).default(1),
        }),
      )
      .max(10),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({
    type: z.literal("clipboard"),
    operation: z.enum(["copy-selection", "paste-text"]),
    text: z.string().max(1_000_000).default(""),
  }),
]);

export const remoteBrowserServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser-state"),
    operationId: z.string().uuid(),
    stateProtection: browserPrivateStateOpaqueSchema,
    title: z.string().max(2_000),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    loading: z.boolean(),
  }),
  z.object({
    type: z.literal("browser-runtime"),
    status: z.enum(["ready", "recovering", "error"]),
    message: z.string().max(2_000).nullable().default(null),
  }),
  z.object({
    type: z.literal("browser-input-focus"),
    editable: z.boolean(),
  }),
]);

export const remoteBrowserCursorMessageSchema = z.object({
  type: z.literal("browser-cursor"),
  cursor: z.enum([
    "auto",
    "default",
    "none",
    "context-menu",
    "help",
    "pointer",
    "progress",
    "wait",
    "cell",
    "crosshair",
    "text",
    "vertical-text",
    "alias",
    "copy",
    "move",
    "no-drop",
    "not-allowed",
    "grab",
    "grabbing",
    "all-scroll",
    "col-resize",
    "row-resize",
    "n-resize",
    "e-resize",
    "s-resize",
    "w-resize",
    "ne-resize",
    "nw-resize",
    "se-resize",
    "sw-resize",
    "ew-resize",
    "ns-resize",
    "nesw-resize",
    "nwse-resize",
    "zoom-in",
    "zoom-out",
  ]),
});

export const remoteBrowserClipboardMessageSchema = z.object({
  type: z.literal("browser-clipboard"),
  operation: z.literal("copy-selection"),
  text: z.string().max(1_000_000),
});

export const remoteSurfaceFrameHeaderSchema = z.object({
  protocolVersion: remoteSurfaceProtocolVersionSchema,
  surfaceId: z.string().min(1).max(200),
  attachmentId: z.string().min(1).max(200),
  sequence: z.number().int().nonnegative().safe(),
  channel: remoteSurfaceChannelSchema,
});

export const REMOTE_SURFACE_MAX_HEADER_BYTES = 64 * 1_024;
export const REMOTE_SURFACE_MAX_PAYLOAD_BYTES = 4 * 1_024 * 1_024;
const REMOTE_SURFACE_FRAME_MAGIC = new Uint8Array([0x43, 0x54, 0x52, 0x53]);

export function encodeRemoteSurfaceFrame(
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  const parsedHeader = remoteSurfaceFrameHeaderSchema.parse(header);
  if (payload.byteLength > REMOTE_SURFACE_MAX_PAYLOAD_BYTES) {
    throw new Error("Remote Surface payload exceeds the protocol limit.");
  }
  const encodedHeader = new TextEncoder().encode(JSON.stringify(parsedHeader));
  if (encodedHeader.byteLength > REMOTE_SURFACE_MAX_HEADER_BYTES) {
    throw new Error("Remote Surface header exceeds the protocol limit.");
  }
  const frame = new Uint8Array(
    8 + encodedHeader.byteLength + payload.byteLength,
  );
  frame.set(REMOTE_SURFACE_FRAME_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, encodedHeader.byteLength, false);
  frame.set(encodedHeader, 8);
  frame.set(payload, 8 + encodedHeader.byteLength);
  return frame;
}

export function decodeRemoteSurfaceFrame(frame: Uint8Array): {
  header: RemoteSurfaceFrameHeader;
  payload: Uint8Array;
} {
  if (frame.byteLength < 8)
    throw new Error("Remote Surface frame is truncated.");
  for (let index = 0; index < REMOTE_SURFACE_FRAME_MAGIC.length; index += 1) {
    if (frame[index] !== REMOTE_SURFACE_FRAME_MAGIC[index]) {
      throw new Error("Remote Surface frame has an invalid magic value.");
    }
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(4, false);
  if (headerLength < 1 || headerLength > REMOTE_SURFACE_MAX_HEADER_BYTES) {
    throw new Error("Remote Surface frame header length is invalid.");
  }
  const payloadOffset = 8 + headerLength;
  if (payloadOffset > frame.byteLength) {
    throw new Error("Remote Surface frame header is truncated.");
  }
  const payloadLength = frame.byteLength - payloadOffset;
  if (payloadLength > REMOTE_SURFACE_MAX_PAYLOAD_BYTES) {
    throw new Error("Remote Surface payload exceeds the protocol limit.");
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(
      new TextDecoder().decode(frame.subarray(8, payloadOffset)),
    );
  } catch {
    throw new Error("Remote Surface frame header is not valid JSON.");
  }
  return {
    header: remoteSurfaceFrameHeaderSchema.parse(rawHeader),
    payload: frame.subarray(payloadOffset),
  };
}

export type RemoteDesktopApplicationIcon = z.infer<
  typeof remoteDesktopApplicationIconSchema
>;
export type RemoteSurfaceConfiguration = z.infer<
  typeof remoteSurfaceConfigurationSchema
>;
export type RemoteSurfaceCreate = z.infer<typeof remoteSurfaceCreateSchema>;
export type EncryptedRemoteSurfaceCreate = z.infer<
  typeof encryptedRemoteSurfaceCreateSchema
>;
export type RemoteSurfaceUpdate = z.infer<typeof remoteSurfaceUpdateSchema>;
export type EncryptedRemoteSurfaceUpdate = z.infer<
  typeof encryptedRemoteSurfaceUpdateSchema
>;
export type RemoteSurfaceSummary = z.infer<typeof remoteSurfaceSummarySchema>;
export type RemoteSurfaceWireSummary = z.infer<
  typeof remoteSurfaceWireSummarySchema
>;
export type RemoteSurfaceViewport = z.infer<typeof remoteSurfaceViewportSchema>;
export type DesktopStreamSettings = z.infer<typeof desktopStreamSettingsSchema>;
export type RemoteSurfaceConnectionMessage = z.infer<
  typeof remoteSurfaceConnectionMessageSchema
>;
export type RemoteSurfaceAttachResult = z.infer<
  typeof remoteSurfaceAttachResultSchema
>;
export type RemoteSurfaceControl = z.infer<typeof remoteSurfaceControlSchema>;
export type RemoteDesktopProbeResult = z.infer<
  typeof remoteDesktopProbeResultSchema
>;
export type RemoteDesktopClientMessage = z.infer<
  typeof remoteDesktopClientMessageSchema
>;
export type RemoteDesktopServerMessage = z.infer<
  typeof remoteDesktopServerMessageSchema
>;
export type RemoteBrowserClientMessage = z.infer<
  typeof remoteBrowserClientMessageSchema
>;
export type RemoteBrowserServerMessage = z.infer<
  typeof remoteBrowserServerMessageSchema
>;
export type RemoteBrowserCursorMessage = z.infer<
  typeof remoteBrowserCursorMessageSchema
>;
export type RemoteBrowserClipboardMessage = z.infer<
  typeof remoteBrowserClipboardMessageSchema
>;
export type RemoteSurfaceFrameHeader = z.infer<
  typeof remoteSurfaceFrameHeaderSchema
>;
