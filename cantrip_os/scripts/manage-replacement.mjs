#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  LocalDocker,
  replaceSystem,
  observeSystemReplacement,
  continueSystemReplacement,
} from "../host/index.mjs";
const [action, requestPath, journalPath, replacementJournalPath] =
  process.argv.slice(2);
const operation = {
  execute: replaceSystem,
  observe: observeSystemReplacement,
  continue: continueSystemReplacement,
}[action];
if (!operation || !requestPath || !journalPath) {
  console.error(
    "Usage: manage-replacement.mjs execute|observe|continue request.json journal.json [original-replacement-journal.json]",
  );
  process.exitCode = 2;
} else {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const result = await operation(await LocalDocker.current(), {
    request,
    journalPath,
    replacementJournalPath,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result || result.operation.state !== "ready") process.exitCode = 1;
}
