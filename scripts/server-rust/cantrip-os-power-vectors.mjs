import { cantripOsPowerFixtures } from "./cantrip-os-power-fixtures.mjs";
import { vectorCases } from "./security-oracle.mjs";

const samples = cantripOsPowerFixtures().cantripOsPowerWorkerCommandSchema.map(
  (command) => ({ kind: "request", requestId: "power-fixture", command }),
);
process.stdout.write(
  JSON.stringify(
    [...vectorCases("workerRequestEnvelopeSchema", samples)].map((test) => ({
      ...test,
      schema: "workerRequestEnvelopeSchema",
    })),
  ),
);
