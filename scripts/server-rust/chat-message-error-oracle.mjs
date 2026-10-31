// Real Source route/global error hook over HTTP, with a controlled repository
// failure at its existing collaborator seam.
import { createRequire } from "node:module";
import { installChatMessageCreateRoute } from "../../cantrip_server/src/app/routes/chat-messages-and-sync.ts";
import { installApplicationErrorHandler } from "../../cantrip_server/src/app/http/error-handler.ts";
import { NativeHistoryError } from "../../cantrip_server/src/db/repository/native-history-bindings.ts";
import { securityFixtures } from "./security-fixtures.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const app = require("fastify")({ logger: false });
let attempt = 0;
installApplicationErrorHandler(app, { clear() {} });
installChatMessageCreateRoute(app, {
  applicationOwnerId: () => "owner",
  repository: {
    async getChatExecutionContext() {
      return { experience: "agent" };
    },
  },
  async appendLiveEncryptedChatMessage() {
    throw new NativeHistoryError(
      ["item-canonical-message-conflict", "output-alias-ambiguous"][attempt++],
    );
  },
});
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = "http://127.0.0.1:" + app.server.address().port;
  const cases = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(origin + "/api/chats/source/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        securityFixtures.chatMessageOpaqueContentListSchema[1][0],
      ),
    });
    cases.push({ status: response.status, body: await response.json() });
  }
  process.stdout.write(JSON.stringify(cases));
} finally {
  await app.close();
}
