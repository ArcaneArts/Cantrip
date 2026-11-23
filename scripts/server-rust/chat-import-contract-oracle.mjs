import * as p from "../../packages/protocol/dist/index.js";
import { vectorCases, outcome } from "./security-oracle.mjs";
import { label, stamp } from "./project-target-state.mjs";
import { chatImportWireFixtures } from "./chat-import-wire-fixtures.mjs";
const { samples, attachment, transcript, selection, job, attachmentId } =
  chatImportWireFixtures(label("chat"), stamp);
const name = process.argv[2],
  cases = [...vectorCases(name, samples[name])];
const add = (input) => {
  const value = outcome(p[name], input);
  cases.push({
    input,
    outcome: value,
    ...(value.issues
      ? { errorMessage: p[name].safeParse(input).error.message }
      : {}),
  });
};
if (name === "externalChatAttachmentSchema")
  for (const status of ["available", "missing", "unsafe", "unsupported"])
    for (const sizeBytes of [0, 1, 128])
      add({ ...attachment, status, sizeBytes });
if (
  name === "externalChatTranscriptSchema" ||
  name === "externalChatReadWorkerResultSchema"
) {
  const addTranscript = (value) =>
    add(
      name === "externalChatReadWorkerResultSchema"
        ? { transcript: value }
        : value,
    );
  const mutate = (fn) => {
    const value = structuredClone(transcript);
    fn(value);
    addTranscript(value);
  };
  mutate((v) => {
    v.titleProtection = label("project");
  });
  mutate((v) => {
    v.attachments.push(structuredClone(v.attachments[0]));
  });
  mutate((v) => {
    v.attachments[0].sizeBytes = 0;
  });
  mutate((v) => {
    v.sync.turns[0].items[0].externalAttachmentIds.push(attachmentId);
  });
  mutate((v) => {
    v.sync.turns[0].items.push({
      ...structuredClone(v.sync.turns[0].items[0]),
      id: "another-user",
    });
  });
  mutate((v) => {
    v.attachments[0].itemId = "other";
  });
  mutate((v) => {
    v.attachments = [];
  });
  mutate((v) => {
    v.sync.turns[0].items[0].externalAttachmentIds = [];
  });
  mutate((v) => {
    v.titleProtection = label("project");
    v.attachments.push(structuredClone(v.attachments[0]));
    v.sync.turns[0].items[0].externalAttachmentIds.push(attachmentId);
    v.attachments[0].itemId = "other";
  });
  mutate((v) => {
    v.attachments = Array.from({ length: 21 }, () =>
      structuredClone(attachment),
    );
  });
  mutate((v) => {
    v.sync.turns[0].items[0].text = "";
  });
  mutate((v) => {
    v.sync.turns[0].items[0].externalAttachmentIds = [null];
  });
}
if (name === "chatImportCreateSchema")
  for (const count of [0, 1, 50, 51])
    add({ imports: Array.from({ length: count }, () => selection) });
if (name === "chatImportJobListSchema")
  for (const count of [0, 1000, 1001])
    add(Array.from({ length: count }, () => job));
console.log(JSON.stringify({ schema: name, cases }));
