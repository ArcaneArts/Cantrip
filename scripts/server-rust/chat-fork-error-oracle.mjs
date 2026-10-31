// Actual source route and error hook over HTTP, with the worker budget failure
// injected at its command-bus seam. No server state or endpoint keys are needed.
import { createRequire } from "node:module";
import { installChatForkRoute } from "../../cantrip_server/src/app/routes/chat-forks.ts";
import { installApplicationErrorHandler } from "../../cantrip_server/src/app/http/error-handler.ts";
import { RelayLimitError } from "../../cantrip_server/src/security/abuse-limits.ts";
import { securityFixtures } from "./security-fixtures.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const app = require("fastify")({ logger: false });
let attempt = 0;
installApplicationErrorHandler(app, { clear() {} });
installChatForkRoute(app, {
  applicationOwnerId: () => "owner",
  bridge: {
    isConnected: () => true,
    async request() {
      throw new RelayLimitError(
        attempt++ === 0
          ? "Controlled fork budget exhausted."
          : "Controlled duplicate fork budget.",
        17,
      );
    },
  },
  repository: {
    async getChatExecutionContext() {
      return {
        contextKind: "project",
        experience: "agent",
        workerId: "worker",
      };
    },
    async forkChat(_owner, _chat, _input, protect) {
      await protect([securityFixtures.chatMessageOpaqueSummarySchema[0]]);
      return null;
    },
  },
  publishChatSummary() {},
  queueStandaloneChatRootJobs() {},
});
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = "http://127.0.0.1:" + app.server.address().port;
  const cases = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(origin + "/api/chats/source/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(securityFixtures.encryptedChatForkSchema[0]),
    });
    cases.push({
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: await response.json(),
    });
  }
  process.stdout.write(JSON.stringify(cases));
} finally {
  await app.close();
}
