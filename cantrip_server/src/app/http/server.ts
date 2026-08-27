import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { ServerConfig } from "../../config.js";
import {
  createServerLogStream,
  SERVER_LOG_REDACTION_PATHS,
} from "../../logger.js";
import {
  DEFAULT_API_BODY_LIMIT_BYTES,
  DEFAULT_UPLOAD_LIMIT_BYTES,
  DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES,
} from "../shared/constants.js";

export interface ApplicationServer {
  app: FastifyInstance;
  encryptedAttachmentUploadLimitBytes: number;
  uploadLimitBytes: number;
  websocketMaxPayloadBytes: number;
}

export function createApplicationServer(
  config: ServerConfig,
  logger: boolean,
): ApplicationServer {
  const apiBodyLimitBytes =
    config.apiBodyLimitBytes ?? DEFAULT_API_BODY_LIMIT_BYTES;
  const uploadLimitBytes =
    config.uploadLimitBytes ?? DEFAULT_UPLOAD_LIMIT_BYTES;
  const encryptedAttachmentUploadLimitBytes =
    Math.ceil(uploadLimitBytes * 1.5) + 1024 * 1024;
  const websocketMaxPayloadBytes =
    config.websocketMaxPayloadBytes ?? DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES;
  const app = Fastify({
    bodyLimit: apiBodyLimitBytes,
    genReqId: () => randomUUID(),
    requestTimeout: 0,
    trustProxy:
      config.trustedProxies && config.trustedProxies.length > 0
        ? config.trustedProxies
        : false,
    logger: logger
      ? {
          stream: createServerLogStream(),
          redact: {
            paths: [...SERVER_LOG_REDACTION_PATHS],
            censor: "[REDACTED]",
          },
        }
      : false,
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { bodyLimit: encryptedAttachmentUploadLimitBytes, parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  return {
    app,
    encryptedAttachmentUploadLimitBytes,
    uploadLimitBytes,
    websocketMaxPayloadBytes,
  };
}
