import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

const sdk = createRequire(
  new URL("../../tests/reference-node-worker/package.json", import.meta.url),
);
const { Client } = await import(
  sdk.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const { StreamableHTTPClientTransport } = await import(
  sdk.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")
);
const oauth = "/api/external-mcp/oauth";
const metadata = "/.well-known/oauth-protected-resource/mcp";
const bearer = (token) => ({ authorization: "Bearer " + token });
const json = (body, headers) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

export async function startHttps(directory) {
  const certificate = path.join(directory, "mcp-https.crt");
  const certificateKey = path.join(directory, "mcp-https.key");
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    certificateKey,
    "-out",
    certificate,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  const ca = tls.getCACertificates("default");
  const cert = await readFile(certificate, "utf8");
  tls.setDefaultCACertificates([...ca, cert]);
  let core, control, bridge, child, childExit;
  const forward = (request, target, receive) =>
    http.request(
      new URL(request.url, target),
      {
        method: request.method,
        headers: {
          ...request.headers,
          host: new URL(issuer).host,
          "x-forwarded-proto": "https",
        },
      },
      receive,
    );
  const serve = (request, response, target) => {
    if (!target) {
      response.writeHead(503).end();
      return;
    }
    const upstream = forward(request, target, (incoming) => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on("error", () => response.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  };
  const proxy = https.createServer(
    { cert, key: await readFile(certificateKey) },
    (request, response) => {
      const route = request.url.split("?", 1)[0];
      const target = route === "/mcp" || route === metadata ? bridge : core;
      serve(request, response, target);
    },
  );
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const issuer = "https://127.0.0.1:" + proxy.address().port;
  const resource = issuer + "/mcp";
  const bridgeKey = "ctbk_" + randomBytes(32).toString("base64url");
  const keyPath = path.join(directory, "mcp-bridge.credential");
  await writeFile(keyPath, bridgeKey + "\n", { mode: 0o600 });
  let localEnabled = true;
  const privateProxy = http.createServer((request, response) => {
    if (!localEnabled && request.url.endsWith("/carrier")) {
      request.resume();
      response.writeHead(409).end();
      return;
    }
    serve(request, response, core);
  });
  privateProxy.on("upgrade", (request, socket, remainder) => {
    const upstream = forward(request, core, () => socket.destroy());
    upstream.on("upgrade", (response, stream, head) => {
      const headers = ["HTTP/1.1 101 Switching Protocols"];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        headers.push(
          response.rawHeaders[index] + ": " + response.rawHeaders[index + 1],
        );
      }
      socket.write(headers.join("\r\n") + "\r\n\r\n");
      socket.write(head);
      stream.write(remainder);
      socket.on("close", () => stream.destroy());
      stream.on("close", () => socket.destroy());
      stream.on("error", () => socket.destroy());
      socket.pipe(stream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  async function configure(origin, worker) {
    core = origin;
    privateProxy.listen(0, "127.0.0.1");
    await once(privateProxy, "listening");
    control = "http://127.0.0.1:" + privateProxy.address().port;
    child = spawn(
      path.resolve(worker),
      [
        "external-mcp",
        "--server",
        control,
        "--http-port",
        "0",
        "--public-url",
        resource,
        "--issuer",
        issuer,
        "--bridge-key-file",
        keyPath,
      ],
      {
        cwd: directory,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    childExit = once(child, "close");
    let diagnostics = "";
    // Keep consuming stderr after startup so subsequent writes cannot block.
    let ready;
    const lines = new Promise((resolve, reject) => {
      child.stderr.on("data", (chunk) => {
        if (ready) return;
        diagnostics += chunk.toString();
        const match = diagnostics.match(
          /listening on (http:\/\/127\.0\.0\.1:\d+)\/mcp/,
        );
        if (match) {
          ready = true;
          resolve(match[1]);
        }
      });
      child.once("error", reject);
      child.once("close", () =>
        reject(new Error("MCP HTTPS bridge exited. " + diagnostics)),
      );
    });
    const timeout = setTimeout(() => child.kill(), 15_000);
    try {
      bridge = await lines;
    } finally {
      clearTimeout(timeout);
    }
    return control;
  }
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "Fixture", version: "1" },
    },
  };
  const send = (token, extra) =>
    fetch(
      resource,
      json(initialize, {
        ...(token ? bearer(token) : {}),
        ...extra,
      }),
    );
  const requireStatus = async (response, status) => {
    assert.equal(
      response.status,
      status,
      "Unexpected HTTP status at " + new URL(response.url).pathname,
    );
    return response;
  };
  const form = (pathname, fields, headers) =>
    fetch(issuer + pathname, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers,
      redirect: "manual",
    });
  const cookies = (client) => ({
    cookie: [...client.client().cookies]
      .map(([key, value]) => key + "=" + value)
      .join("; "),
  });

  async function verify({
    owner,
    unrelated,
    grant,
    projectId,
    workerId,
    revoke,
    startChannel,
    open,
  }) {
    const absent = await requireStatus(await send(), 401);
    assert.match(
      absent.headers.get("www-authenticate"),
      /resource_metadata="https:.*\/oauth-protected-resource\/mcp"/,
    );
    assert.deepEqual(
      await (await requireStatus(await fetch(issuer + metadata), 200)).json(),
      {
        resource,
        authorization_servers: [issuer],
        scopes_supported: ["mcp"],
        bearer_methods_supported: ["header"],
      },
    );
    await requireStatus(
      await send(undefined, { origin: "https://unrelated.invalid" }),
      403,
    );
    await requireStatus(await send(grant.credential), 401);
    await requireStatus(await fetch(bridge + metadata), 403);
    const redirectUrl = "http://127.0.0.1:52321/authorize/callback";
    const state = randomUUID();
    let clientInformation, tokens, authorization, verifier;
    const provider = {
      redirectUrl,
      clientMetadata: {
        redirect_uris: [redirectUrl],
        client_name: "Independent Cantrip MCP SDK",
        token_endpoint_auth_method: "none",
      },
      state: () => state,
      clientInformation: () => clientInformation,
      saveClientInformation: (value) => {
        clientInformation = value;
      },
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value;
      },
      redirectToAuthorization: (value) => {
        authorization = value;
      },
      codeVerifier: () => verifier,
      saveCodeVerifier: (value) => {
        verifier = value;
      },
    };
    const name = { name: "independent-mcp-sdk-https", version: "1" };
    const url = new URL(resource);
    const discover = new StreamableHTTPClientTransport(url, {
      authProvider: provider,
    });
    const sdkDiscovery = new Client(name);
    try {
      await assert.rejects(sdkDiscovery.connect(discover), /authoriz/i);
      assert.ok(authorization);
      assert.equal(authorization.searchParams.get("resource"), resource);
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      await requireStatus(await fetch(authorization), 401);
      const deniedForm = await (
        await requireStatus(
          await fetch(authorization, { headers: cookies(owner) }),
          200,
        )
      ).text();
      const denied = await requireStatus(
        await form(
          oauth + "/authorize",
          {
            consent: deniedForm.match(/name="consent" value="([^"]+)"/)[1],
            deny: "true",
          },
          { ...cookies(owner), origin: issuer },
        ),
        303,
      );
      const error = new URL(denied.headers.get("location")).searchParams;
      assert.equal(error.get("error"), "access_denied");
      assert.equal(error.get("state"), state);
      assert.equal(error.get("code"), null);
      const approval = await (
        await requireStatus(
          await fetch(authorization, { headers: cookies(owner) }),
          200,
        )
      ).text();
      assert.ok(
        approval.includes(grant.integration.id),
        "Consent lists the owner's integration",
      );
      const consent = approval.match(/name="consent" value="([^"]+)"/)[1];
      const selection = { consent, integration: grant.integration.id };
      await requireStatus(
        await form(oauth + "/authorize", selection, cookies(unrelated)),
        400,
      );
      await requireStatus(
        await form(oauth + "/authorize", selection, {
          ...cookies(owner),
          origin: "https://unrelated.invalid",
        }),
        403,
      );
      const approved = await requireStatus(
        await form(oauth + "/authorize", selection, {
          ...cookies(owner),
          origin: issuer,
        }),
        303,
      );
      const redirect = new URL(approved.headers.get("location"));
      const code = redirect.searchParams.get("code");
      assert.equal(redirect.origin + redirect.pathname, redirectUrl);
      assert.equal(redirect.searchParams.get("state"), state);
      assert.equal(redirect.searchParams.get("iss"), issuer);
      const exchangeCode = {
        client_id: clientInformation.client_id,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUrl,
        code_verifier: verifier,
        resource,
      };
      await requireStatus(
        await form(oauth + "/token", {
          ...exchangeCode,
          code_verifier: randomBytes(32).toString("base64url"),
        }),
        400,
      );
      await requireStatus(
        await form(oauth + "/token", {
          ...exchangeCode,
          resource: issuer + "/different",
        }),
        400,
      );
      await discover.finishAuth(code);
      await requireStatus(await form(oauth + "/token", exchangeCode), 400);
    } finally {
      await sdkDiscovery.close();
    }

    const client = new Client(name);
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, { authProvider: provider }),
      );
      const modern = "2026-07-28";
      const discovery = await requireStatus(
        await fetch(
          resource,
          json(
            {
              jsonrpc: "2.0",
              id: 2,
              method: "server/discover",
              params: {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": modern,
                  "io.modelcontextprotocol/clientInfo": name,
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            },
            {
              ...bearer(tokens.access_token),
              "mcp-protocol-version": modern,
              "mcp-method": "server/discover",
            },
          ),
        ),
        200,
      );
      assert.equal((await discovery.json()).result.resultType, "complete");
      assert.ok(
        (await client.listTools()).tools.some(
          ({ name }) => name === "worker_context",
        ),
      );
      const result = await client.callTool({
        name: "worker_context",
        arguments: { projectId },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.equal(result.structuredContent.workerId, workerId);
      await requireStatus(
        await fetch(control + "/api/external-mcp/hosted/capabilities", {
          headers: bearer(tokens.access_token),
        }),
        401,
      );
      await requireStatus(
        await fetch(
          issuer + oauth + "/exchange",
          json({
            accessToken: tokens.access_token,
            resource,
          }),
        ),
        401,
      );
      await requireStatus(
        await fetch(
          issuer + oauth + "/exchange",
          json(
            {
              accessToken: tokens.access_token,
              resource: issuer + "/different",
            },
            bearer(bridgeKey),
          ),
        ),
        401,
      );
      const refresh = {
        client_id: clientInformation.client_id,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource,
      };
      const refreshed = await (
        await requireStatus(await form(oauth + "/token", refresh), 200)
      ).json();
      await requireStatus(await form(oauth + "/token", refresh), 400);
      await requireStatus(await send(refreshed.access_token), 200);
      await requireStatus(
        await send(refreshed.access_token, {
          "mcp-protocol-version": "2099-01-01",
        }),
        400,
      );
      const issued = await (
        await requireStatus(
          await fetch(
            control + oauth + "/exchange",
            json(
              {
                accessToken: refreshed.access_token,
                resource,
              },
              bearer(bridgeKey),
            ),
          ),
          200,
        )
      ).json();
      const active = await startChannel(
        issued.credential,
        await open(issued.credential, projectId),
      );
      const disconnected = once(active.socket, "close", {
        signal: AbortSignal.timeout(10_000),
      });
      await revoke();
      await disconnected;
      await requireStatus(await send(refreshed.access_token), 401);
      await requireStatus(
        await form(oauth + "/token", {
          ...refresh,
          refresh_token: refreshed.refresh_token,
        }),
        400,
      );
    } finally {
      await client.close();
    }
  }

  return {
    env: {
      CANTRIP_PUBLIC_ORIGIN: issuer,
      CANTRIP_EXTERNAL_MCP_PUBLIC_URL: resource,
      CANTRIP_EXTERNAL_MCP_BRIDGE_KEY: bridgeKey,
      CANTRIP_TRUSTED_PROXIES: "loopback",
    },
    configure,
    verify,
    setLocalEnabled: (enabled) => {
      localEnabled = enabled;
    },
    async close() {
      if (child) {
        child.kill();
        await childExit;
      }
      proxy.closeAllConnections();
      proxy.close();
      privateProxy.closeAllConnections();
      privateProxy.close();
      tls.setDefaultCACertificates(ca);
    },
  };
}
