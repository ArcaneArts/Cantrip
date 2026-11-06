#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { packageControl } from "../host/index.mjs";

const [flag, transportPath, action, operation, sha256, artifact, ...extra] =
  process.argv.slice(2);
if (
  flag !== "--transport" ||
  !transportPath ||
  extra.length ||
  !["admit", "receive", "start", "inspect", "abandon", "probe"].includes(
    action,
  ) ||
  (action === "probe" ? operation !== undefined : !operation) ||
  (action === "receive" ? !sha256 || !artifact : sha256 !== undefined)
) {
  console.error(
    "Usage: manage-packages.mjs --transport transport.json admit request.json\n" +
      "       manage-packages.mjs --transport transport.json receive UUID SHA256 package.deb\n" +
      "       manage-packages.mjs --transport transport.json start|inspect|abandon UUID\n" +
      "       manage-packages.mjs --transport transport.json probe",
  );
  process.exitCode = 1;
} else {
  const transport = JSON.parse(await readFile(transportPath, "utf8"));
  const args =
    action === "probe"
      ? [action]
      : action === "admit"
        ? [
            action,
            JSON.stringify(JSON.parse(await readFile(operation, "utf8"))),
          ]
        : action === "receive"
          ? [action, operation, sha256]
          : [action, operation];
  const result = await packageControl(
    transport,
    args,
    action === "receive" ? { input: createReadStream(artifact) } : {},
  );
  console.log(JSON.stringify(result, null, 2));
}
