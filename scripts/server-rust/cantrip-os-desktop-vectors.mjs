import { cantripOsDesktopFixtures } from "./cantrip-os-desktop-fixtures.mjs";
import { vectorCases } from "./security-oracle.mjs";

const samples =
  cantripOsDesktopFixtures().cantripOsDesktopWorkerCommandSchema.map(
    (command) => ({ kind: "request", requestId: "desktop-fixture", command }),
  );
process.stdout.write(
  JSON.stringify(
    [...vectorCases("workerRequestEnvelopeSchema", samples)].map((test) => ({
      ...test,
      schema: "workerRequestEnvelopeSchema",
    })),
  ),
);
