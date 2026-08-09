"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseRequest,
  reconnectDelayMs,
  safeRelativePaths,
  themeNameForAppearance,
} = require("../src/protocol.js");

test("parses bounded bridge requests", () => {
  assert.deepEqual(
    parseRequest(
      JSON.stringify({
        type: "request",
        id: "one",
        method: "saveAll",
        params: { explicit: true },
      }),
    ),
    {
      type: "request",
      id: "one",
      method: "saveAll",
      params: { explicit: true },
    },
  );
  assert.equal(parseRequest("not json"), null);
  assert.equal(parseRequest('{"type":"state"}'), null);
});

test("rejects absolute and escaping external paths", () => {
  assert.deepEqual(
    safeRelativePaths([
      "src/main.ts",
      "./README.md",
      "src\\main.ts",
      "../secret",
      "/etc/passwd",
      "C:/Windows/system.ini",
      "src//bad.ts",
    ]),
    ["src/main.ts", "README.md"],
  );
});

test("bounds bridge reconnect backoff", () => {
  assert.equal(reconnectDelayMs(0), 500);
  assert.equal(reconnectDelayMs(2), 2_000);
  assert.equal(reconnectDelayMs(20), 15_000);
});

test("maps every Cantrip appearance to its bundled editor theme", () => {
  assert.equal(themeNameForAppearance("light"), "Cantrip Light");
  assert.equal(themeNameForAppearance("dark"), "Cantrip Dark");
  assert.equal(
    themeNameForAppearance("high-contrast-light"),
    "Cantrip High Contrast Light",
  );
  assert.equal(
    themeNameForAppearance("high-contrast-dark"),
    "Cantrip High Contrast Dark",
  );
  assert.equal(themeNameForAppearance("independent"), null);
});
