// Production worker services, with controlled search/fetch/browser boundaries.
// This proves server negotiation and worker routing, not managed-browser QA.
import assert from "node:assert/strict";
import { WorkerWebService } from "../../cantrip_worker/src/web/service.ts";
import { RobotsPolicy } from "../../cantrip_worker/src/web/robots.ts";

export const workerLocalOperations = [
  "tool.help",
  "web.search",
  "web.read",
  "web.session.snapshot",
  "web.session.open",
  "web.session.click",
  "web.session.pointer",
  "web.session.type",
  "web.session.close",
];
export const privateWebText = "Worker-private research content. ".repeat(120);
export const elementRef = `wer_${"B".repeat(32)}`;
export function workerWebFixture() {
  const calls = [],
    sessions = new Map();
  let sequence = 0;
  const read = (binding, id) => {
    const session = sessions.get(id);
    assert.ok(session, "controlled browser session exists");
    assert.equal(session.owner, binding.ownerId);
    assert.equal(session.chat, binding.chatId);
    return session;
  };
  const record = (operation, binding, args) =>
    calls.push({ operation, chatId: binding.chatId, args });
  const action = (operation, binding, id, args) => {
    record(operation, binding, args);
    const session = read(binding, id);
    session.state.generation += 1;
    return { ...session.state };
  };
  const page = async (url) => {
    calls.push({ operation: "fetch", url });
    return {
      body: Buffer.from(
        url.endsWith("/robots.txt")
          ? "User-agent: *\nAllow: /\n"
          : privateWebText,
      ),
      charset: "utf-8",
      contentType: "text/plain",
      headers: {},
      status: 200,
      url,
    };
  };
  const service = new WorkerWebService({
    fetchPage: page,
    robots: new RobotsPolicy({ fetch: page }),
    searchRuntime: {
      async request(path, parameters, timeout) {
        calls.push({
          operation: "search",
          path,
          parameters: [...parameters],
          timeout,
        });
        return {
          query: parameters.get("q"),
          results: [
            {
              url: "https://example.com/research",
              title: "Worker research",
              content: "A controlled public page.",
              engines: ["fixture"],
            },
          ],
        };
      },
    },
    sessionRuntime: {
      async openSession(binding, url, options) {
        record("open", binding, {
          url,
          browserTarget: options.browserTarget ?? null,
        });
        await options.beforeNavigation(new URL(url));
        if (options.sessionId)
          return action("navigate", binding, options.sessionId, { url });
        const sessionId = `wss_${String(++sequence).padStart(32, "A")}`;
        const state = {
          sessionId,
          url,
          title: "Worker-private browser",
          generation: 1,
          persistent: false,
        };
        sessions.set(sessionId, {
          owner: binding.ownerId,
          chat: binding.chatId,
          state,
        });
        return { ...state };
      },
      async snapshotSession(binding, id, maxChars) {
        record("snapshot", binding, { id, maxChars });
        return {
          ...read(binding, id).state,
          snapshot: "Worker-private accessibility tree",
          elements: [{ ref: elementRef, description: "Search input" }],
          truncated: false,
        };
      },
      async clickSession(binding, id, ref) {
        assert.equal(ref, elementRef);
        return action("click", binding, id, { ref });
      },
      async pointerSession(binding, input) {
        return action("pointer", binding, input.sessionId, input);
      },
      async typeSession(binding, id, ref, text, submit) {
        assert.equal(ref, elementRef);
        return action("type", binding, id, { ref, text, submit });
      },
      async closeSession(binding, id) {
        record("close", binding, { id });
        read(binding, id);
        sessions.delete(id);
      },
      cancelBinding(binding) {
        record("cancel", binding, {});
        for (const [id, session] of sessions)
          if (
            session.owner === binding.ownerId &&
            session.chat === binding.chatId
          )
            sessions.delete(id);
      },
    },
  });
  return { service, calls };
}
