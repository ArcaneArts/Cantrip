"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("opens the authenticated bridge before awaiting presentation setup", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../src/extension.js"),
    "utf8",
  );
  const start = source.match(
    /async start\(\) \{(?<body>[\s\S]*?)\n  \}\n\n  registerCommands/u,
  )?.groups?.body;

  assert.ok(start, "WorkbenchCoordinator.start must remain discoverable");
  const registration = start.indexOf("this.registerCommands();");
  const reconnect = start.indexOf("this.reconnect(true);", registration);
  const presentation = start.indexOf(
    "await configureWorkbenchPresentation",
    registration,
  );
  assert.notEqual(registration, -1, "command registration must remain present");
  assert.notEqual(
    reconnect,
    -1,
    "startup bridge connection must remain present",
  );
  assert.notEqual(presentation, -1, "presentation setup must remain present");
  assert.ok(
    registration < reconnect && reconnect < presentation,
    "bridge connection must begin before presentation commands are awaited",
  );
});
