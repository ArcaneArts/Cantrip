// Executed by the Rust integration test. The Node implementation supplies the
// expected values/errors; this file supplies inputs, never a second validator.
import { readFile } from "node:fs/promises";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { observeConfiguration } from "./config-oracle.mjs";

const source = parse(
  await readFile(
    new URL("../../cantrip_server/src/config.ts", import.meta.url),
    "utf8",
  ),
  { sourceType: "module", plugins: ["typescript"] },
);
const cases = [{ name: "defaults", environment: {} }];
const add = (name, environment) => cases.push({ name, environment });
const evaluate = (node) => {
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "ParenthesizedExpression") return evaluate(node.expression);
  if (node.type === "BinaryExpression") {
    const left = evaluate(node.left),
      right = evaluate(node.right);
    switch (node.operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return left / right;
    }
  }
  throw new Error(`Unsupported numeric fixture expression: ${node.type}`);
};
const bounded = [];
const booleans = new Set();
const traverse = traverseModule.default ?? traverseModule;
traverse(source, {
  CallExpression({ node }) {
    if (
      node.callee.type === "Identifier" &&
      node.arguments[0]?.type === "StringLiteral"
    ) {
      const name = node.arguments[0].value;
      if (node.callee.name === "readBoundedInteger")
        bounded.push({
          name,
          fallback: evaluate(node.arguments[2]),
          min: evaluate(node.arguments[3]),
          max: evaluate(node.arguments[4]),
        });
      if (node.callee.name === "readBoolean") booleans.add(name);
    }
  },
});
for (const { name, min, max } of bounded) {
  const base =
    name === "CANTRIP_TURN_TTL_SECONDS"
      ? {
          CANTRIP_TURN_URLS: "turn:fixture.invalid",
          CANTRIP_TURN_SHARED_SECRET: "synthetic-fixture-only",
        }
      : {};
  for (const value of [
    String(min),
    String(max),
    String(min - 1),
    String(max + 1),
    `+${min}suffix`,
    "NaN",
    "",
    `\ufeff${min}`,
    `\u0085${min}`,
  ])
    add(`${name}=${JSON.stringify(value)}`, { ...base, [name]: value });
}
for (const name of booleans)
  for (const value of ["true", "false", "1", "0", "", "yes", "TRUE"])
    add(`${name}=${JSON.stringify(value)}`, { [name]: value });
for (const value of [
  "0",
  "1",
  "65535",
  "65536",
  "+4310suffix",
  " 4310 ",
  "1e3",
  "0x10",
  "",
  "\ufeff4310",
  "\u00854310",
  "9".repeat(1000),
])
  add(`port=${JSON.stringify(value)}`, { CANTRIP_SERVER_PORT: value });

const key = Buffer.alloc(32, 17).toString("base64");
const hosted = {
  CANTRIP_DEPLOYMENT_MODE: "hosted",
  CANTRIP_BOOTSTRAP_MODE: "hosted",
  CANTRIP_AUTH_MODE: "accounts",
  CANTRIP_ADMIN_EMAIL: "fixture@example.invalid",
  CANTRIP_APP_ORIGINS: "https://app.example.invalid",
  CANTRIP_PUBLIC_ORIGIN: "https://api.example.invalid",
  CANTRIP_TRUSTED_PROXIES: "loopback",
  DATABASE_URL:
    "postgres://fixture:synthetic@example.invalid/fixture?sslmode=require",
  CANTRIP_SECRET_ENCRYPTION_KEYS: JSON.stringify({ fixture: key }),
};
add("hosted", hosted);
for (const name of Object.keys(hosted))
  add(
    `hosted without ${name}`,
    Object.fromEntries(Object.entries(hosted).filter(([key]) => key !== name)),
  );
for (const value of ["lax", "none", "strict", "", "other"])
  add(`hosted same-site=${value}`, {
    ...hosted,
    CANTRIP_COOKIE_SAME_SITE: value,
  });
for (const value of ["false", "0", "true", "1", "yes"])
  add(`hosted secure=${value}`, { ...hosted, CANTRIP_COOKIE_SECURE: value });
add("hosted insecure override", {
  ...hosted,
  CANTRIP_ALLOW_INSECURE_REMOTE: "true",
});
for (const auth of ["none", "password", "accounts", "other"])
  for (const bootstrap of [
    "pnpm-dev",
    "tauri",
    "standalone",
    "hosted",
    "other",
  ]) {
    add(`local ${auth}/${bootstrap}`, {
      CANTRIP_AUTH_MODE: auth,
      CANTRIP_BOOTSTRAP_MODE: bootstrap,
      CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
      CANTRIP_PASSWORD_HASH: "$argon2id$synthetic-fixture-only",
    });
    add(`worker token ${auth}/${bootstrap}`, {
      CANTRIP_AUTH_MODE: auth,
      CANTRIP_BOOTSTRAP_MODE: bootstrap,
      CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
      CANTRIP_PASSWORD_HASH: "$argon2id$synthetic-fixture-only",
      CANTRIP_WORKER_TOKEN: "synthetic-fixture-only",
    });
  }
for (const host of [
  "127.0.0.1",
  "localhost",
  "::1",
  "127.0.0.2",
  "LOCALHOST",
  "0.0.0.0",
  "",
  "example.invalid",
])
  for (const allow of ["false", "true"])
    add(`host ${host}/${allow}`, {
      CANTRIP_SERVER_HOST: host,
      CANTRIP_ALLOW_INSECURE_REMOTE: allow,
    });
for (const name of [
  "CANTRIP_PASSWORD_HASH",
  "CANTRIP_ADMIN_BOOTSTRAP_TOKEN",
  "CANTRIP_METRICS_TOKEN",
  "CANTRIP_SERVER_INSTANCE_ID",
])
  for (const value of [
    "",
    " ",
    "a",
    "a".repeat(32),
    "a".repeat(101),
    "🦀".repeat(16),
    "\ufeffvalue\ufeff",
    "\u0085value\u0085",
    "a\nb",
  ])
    add(`${name} text ${JSON.stringify(value)}`, { [name]: value });
for (const value of [
  "",
  "bad",
  ".a@example.invalid",
  "a..b@example.invalid",
  "a+b@example.invalid",
  "a_@example.invalid",
  "a@example.invalid\n",
  "Ａ@example.invalid",
  "'a'@example.invalid",
  "a@b-.invalid",
  `${"x".repeat(309)}@example.invalid`,
])
  add(`admin email ${JSON.stringify(value)}`, { CANTRIP_ADMIN_EMAIL: value });
for (const value of [
  "",
  "short",
  " ".repeat(12),
  "🦀".repeat(6),
  "🦀".repeat(513),
  "x".repeat(1025),
])
  add(`admin password ${JSON.stringify(value)}`, {
    CANTRIP_AUTH_MODE: "accounts",
    CANTRIP_ADMIN_EMAIL: "fixture@example.invalid",
    CANTRIP_ADMIN_PASSWORD: value,
  });
for (const value of [
  "",
  "redis://example.invalid",
  "rediss://fixture:synthetic@example.invalid:6379",
  "redis:opaque",
  "https://example.invalid",
  "invalid",
  "redis://[bad]",
])
  add(`redis ${value}`, { REDIS_URL: value });
for (const divisor of ["2", "3", "32"])
  add(`scaled ${divisor}`, {
    CANTRIP_COORDINATION_MAX_INSTANCES: divisor,
    REDIS_URL: "redis://example.invalid",
  });
add("scaled without Redis", { CANTRIP_COORDINATION_MAX_INSTANCES: "2" });
add("scaled minimum too low", {
  CANTRIP_COORDINATION_MAX_INSTANCES: "2",
  REDIS_URL: "redis://example.invalid",
  CANTRIP_AUTH_RATE_LIMIT: "1",
});

for (const value of [
  "",
  ".",
  "data/../fixture",
  "../../..",
  "/",
  "/fixture/../../data",
  "a//b/./c/../",
  "data dir/🦀",
  "C:\\data\\..\\fixture",
  "\\fixture",
  "C:fixture",
])
  add(`data directory ${value}`, { CANTRIP_DATA_DIR: value });
for (const value of [
  "",
  " ",
  "postgres://fixture:synthetic@127.0.0.1/fixture",
  "not-a-url",
])
  add(`database URL ${value}`, { DATABASE_URL: value });
for (const value of [
  "https://EXAMPLE.INVALID:443/",
  "http://127.1",
  "http://[::1]:80",
  "http://a/.",
  "http://a/?",
  "http://a/#",
  "http://a/?x",
  "http://a/#x",
  "https://u:synthetic@a",
  "ftp://a/",
  "not a URL",
  "http://a/path",
  "http://*.example.invalid",
  "http://☃.example.invalid",
])
  add(`public origin ${value}`, { CANTRIP_PUBLIC_ORIGIN: value });
for (const value of [
  "",
  ",",
  "http://A:80,http://a/",
  "tauri://localhost,capacitor://localhost",
  "TAURI://localhost",
  "http://*.example.invalid",
  "https://a,https://b/path",
  Array.from({ length: 33 }, (_, i) => `https://a${i}`).join(","),
])
  add(`app origins ${value}`, { CANTRIP_APP_ORIGINS: value });
add("singular app origin alias", {
  CANTRIP_APP_ORIGIN: "http://localhost:5173",
});
add("empty plural overrides alias", {
  CANTRIP_APP_ORIGIN: "http://localhost:5173",
  CANTRIP_APP_ORIGINS: "",
});
for (const value of [
  "http://example.invalid",
  "http://localhost",
  "http://a.localhost",
  "http://127.1",
  "http://[::1]",
  "capacitor://localhost",
])
  add(`hosted app origins ${value}`, { ...hosted, CANTRIP_APP_ORIGINS: value });
for (const value of [
  "",
  "LOOPBACK,loopback",
  "127.0.0.1/32",
  "127.0.0.1/",
  "127.0.0.1/0x20",
  "127.0.0.1/1e1",
  "127.0.0.1/-0",
  "127.0.0.1/33",
  "127.1",
  "010.0.0.1",
  "::1/128",
  "::1/129",
  "fe80::1%eth0",
  "fe80::1%eth_0",
  "[::1]",
  "bad",
  Array(33).fill("loopback").join(","),
])
  add(`trusted proxies ${value}`, { CANTRIP_TRUSTED_PROXIES: value });

for (const name of [
  "CANTRIP_WORKER_LINK_INTERFACE_ALLOWLIST",
  "CANTRIP_WORKER_LINK_INTERFACE_DENYLIST",
  "CANTRIP_WORKER_LINK_VPN_LAN_ALLOWLIST",
])
  for (const value of [
    "",
    "eth0",
    " eth0 , tun0 ",
    "eth0,eth0",
    "a\nb",
    "x".repeat(201),
    "🦀".repeat(100),
    "🦀".repeat(101),
    Array.from({ length: 65 }, (_, i) => `eth${i}`).join(","),
  ])
    add(`${name} ${JSON.stringify(value)}`, { [name]: value });
add("conflicting interface lists", {
  CANTRIP_WORKER_LINK_INTERFACE_ALLOWLIST: "eth0",
  CANTRIP_WORKER_LINK_INTERFACE_DENYLIST: "tun0",
});
for (const value of [
  "",
  "stun:fixture.invalid",
  "stuns:fixture.invalid",
  "STUN:fixture.invalid",
  "stun:",
  "stun:a b",
  "stun:🦀",
  "stun:\u0085",
  "stun:" + "a".repeat(2044),
  "stun:a,stun:a",
  Array.from({ length: 9 }, (_, i) => `stun:${i}`).join(","),
])
  add(`worker STUN ${JSON.stringify(value)}`, {
    CANTRIP_WORKER_LINK_STUN_URLS: value,
  });
add("disabled WAN ignores malformed STUN", {
  CANTRIP_WORKER_LINK_WAN_ENABLED: "false",
  CANTRIP_WORKER_LINK_STUN_URLS: "invalid",
});
add("relay short-circuits disabled options", {
  CANTRIP_WORKER_LINK_RELAY_ONLY: "true",
  CANTRIP_WORKER_LINK_WAN_ENABLED: "bad",
  CANTRIP_WORKER_LINK_LOCAL_ENABLED: "bad",
  CANTRIP_WORKER_LINK_LAN_ENABLED: "bad",
  CANTRIP_WORKER_LINK_STUN_URLS: "invalid",
});
for (const value of [
  "",
  "{",
  "null",
  "[]",
  "1",
  "{}",
  '{"unknown":{}}',
  '{"events":null}',
  '{"events":[]}',
  '{"events":{"unknown":1}}',
])
  add(`lane JSON ${value}`, { CANTRIP_WORKER_LINK_LANE_LIMITS: value });
for (const lane of ["events", "interactive", "stream", "realtime", "bulk"])
  for (const field of [
    "maxChannels",
    "maxQueuedFrames",
    "maxQueuedBytes",
    "maxBytesPerSecond",
  ])
    for (const value of [
      1,
      4096,
      65536,
      1073741824,
      0,
      -1,
      1.5,
      "1",
      null,
      false,
      [],
      {},
      9007199254740992,
    ])
      add(`lane ${lane}.${field}=${JSON.stringify(value)}`, {
        CANTRIP_WORKER_LINK_LANE_LIMITS: JSON.stringify({
          [lane]: { [field]: value },
        }),
      });
for (const value of ["all", "relay", " relay ", "bad"])
  add(`ICE policy ${value}`, { CANTRIP_WEBRTC_ICE_TRANSPORT_POLICY: value });
for (const value of [
  "turn:fixture.invalid",
  "turns:fixture.invalid",
  "stun:fixture.invalid",
  "TURN:fixture.invalid",
  "turn:",
]) {
  add(`TURN without secret ${value}`, { CANTRIP_TURN_URLS: value });
  add(`TURN ${value}`, {
    CANTRIP_TURN_URLS: value,
    CANTRIP_TURN_SHARED_SECRET: " synthetic ",
    CANTRIP_WEBRTC_ICE_TRANSPORT_POLICY: "relay",
  });
}
for (const value of [
  "stun:fixture.invalid",
  "stuns:fixture.invalid",
  "turn:fixture.invalid",
  "stun:",
  "stun:a b",
  "stun:a,stun:a",
])
  add(`WebRTC STUN ${value}`, { CANTRIP_STUN_URLS: value });

for (const value of [
  "",
  " ",
  "{",
  "null",
  "[]",
  "{}",
  JSON.stringify({ fixture: key }),
  JSON.stringify({ "bad id": key }),
  JSON.stringify({ fixture: null }),
  JSON.stringify({ fixture: key.trimEnd().slice(0, -1) }),
  JSON.stringify({ fixture: key + " " }),
  JSON.stringify({ fixture: Buffer.alloc(31).toString("base64") }),
  JSON.stringify({ a: key, b: key }),
  JSON.stringify(
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, key])),
  ),
])
  add(`keyring ${value}`, { CANTRIP_SECRET_ENCRYPTION_KEYS: value });
add("numeric key IDs retain JS order", {
  CANTRIP_SECRET_ENCRYPTION_KEYS:
    '{"10":"' +
    key +
    '","2":"' +
    key +
    '","z":"' +
    key +
    '","a":"' +
    key +
    '"}',
  CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID: "2",
});
for (const value of ["", "a", "b", " c "])
  add(`active encryption key ${value}`, {
    CANTRIP_SECRET_ENCRYPTION_KEYS: JSON.stringify({ a: key, b: key }),
    CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID: value,
  });
add("secret validation precedes password validation", {
  CANTRIP_SECRET_ENCRYPTION_KEYS: "{",
  CANTRIP_AUTH_MODE: "password",
});
add("cookie validation precedes worker numeric validation", {
  CANTRIP_COOKIE_SECURE: "bad",
  CANTRIP_WORKER_COMMAND_CONCURRENCY: "bad",
});
add("lane validation precedes STUN schema validation", {
  CANTRIP_WORKER_LINK_LANE_LIMITS: "{",
  CANTRIP_WORKER_LINK_STUN_URLS: "bad",
});

process.stdout.write(`${JSON.stringify(observeConfiguration(cases))}\n`);
