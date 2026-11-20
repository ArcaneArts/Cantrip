import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

export const oauthServer = "inventory_oauth_fixture";

const code = "cantrip-fixture-only-authorization-code";
const token = "cantrip-fixture-only-access-token";
const denial = "Cantrip fixture's private provider error";

async function requestText(request) {
  const data = [];
  for await (const chunk of request) data.push(chunk);
  return Buffer.concat(data).toString();
}

export async function startMcpOauthFixture() {
  let origin;
  let authenticatedInitializations = 0;
  const exchanges = [];
  const peer = createServer(async (request, response) => {
    const respond = (status, payload, headers = {}) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify(payload));
    };
    const { pathname } = new URL(request.url, origin);
    if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return respond(200, {
        resource: origin + "/mcp",
        authorization_servers: [origin],
      });
    }
    if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return respond(200, {
        issuer: pathname.endsWith("/mcp") ? origin + "/mcp" : origin,
        authorization_endpoint: origin + "/oauth/authorize",
        token_endpoint: origin + "/oauth/token",
        registration_endpoint: origin + "/oauth/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["read"],
      });
    }
    if (pathname === "/oauth/register") {
      const registration = JSON.parse(await requestText(request));
      return respond(201, {
        ...registration,
        client_id: "cantrip-fixture-public-client",
      });
    }
    if (pathname === "/oauth/token") {
      const form = new URLSearchParams(await requestText(request));
      exchanges.push(form);
      if (form.get("code") === code) {
        return respond(200, {
          access_token: token,
          token_type: "Bearer",
          scope: "read",
          expires_in: 3600,
        });
      }
      return respond(400, { error: "invalid_grant" });
    }
    if (pathname === "/mcp") {
      if (request.headers.authorization !== `Bearer ${token}`) {
        return respond(
          401,
          {},
          {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        );
      }
      if (request.method !== "POST") return respond(405, {});
      const { id, method, params } = JSON.parse(await requestText(request));
      if (method === "initialize") authenticatedInitializations++;
      if (id === undefined) {
        response.writeHead(202);
        return response.end();
      }
      return respond(200, {
        jsonrpc: "2.0",
        id,
        result:
          method === "initialize"
            ? {
                protocolVersion: params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: oauthServer, version: "1" },
              }
            : { tools: [] },
      });
    }
    return respond(404, {});
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  const { port } = peer.address();
  origin = `http://127.0.0.1:${port}`;
  const url = origin + "/mcp";
  return {
    url,
    config: `mcp_oauth_credentials_store = "file"\n[mcp_servers.${oauthServer}]\nurl = "${url}"\n[features]\nhooks = true\n`,
    async callback(authorizationUrl, allowed) {
      const authorization = new URL(authorizationUrl);
      assert.equal(authorization.origin, origin);
      assert.equal(authorization.pathname, "/oauth/authorize");
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      assert.ok(["127.0.0.1", "localhost"].includes(callback.hostname));
      const state = authorization.searchParams.get("state");
      assert.ok(state);
      callback.searchParams.set("state", state);
      if (allowed) callback.searchParams.set("code", code);
      else {
        callback.searchParams.set("error", "access_denied");
        callback.searchParams.set("error_description", denial);
      }
      const result = await fetch(callback, { redirect: "manual" });
      await result.text();
      assert.ok(result.status < 500);
    },
    verifyExchange() {
      assert.equal(exchanges.length, 1);
      const [request] = exchanges;
      assert.equal(request.get("grant_type"), "authorization_code");
      assert.equal(request.get("code"), code);
      assert.ok(request.get("code_verifier"));
    },
    verifyConnection() {
      assert.ok(authenticatedInitializations > 0);
    },
    close() {
      peer.close();
      peer.closeAllConnections();
    },
  };
}
