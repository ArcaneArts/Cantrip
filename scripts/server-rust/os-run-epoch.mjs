import { osRunExecutionKey } from "../../tests/reference-node-server/src/db/repository/cantrip-os-run-capture.ts";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const roots = JSON.parse(input);
process.stdout.write(osRunExecutionKey(roots) + "\n");
