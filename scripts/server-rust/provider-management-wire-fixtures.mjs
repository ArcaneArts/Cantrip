import { policyEnvelope } from "./policy-wire-fixtures.mjs";

const account = {
  id: "22222222-2222-4222-8222-222222222222",
  protectedLabel: policyEnvelope,
};
const create = {
  id: "11111111-1111-4111-8111-111111111111",
  name: " Fixture provider ",
  kind: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
  initialAccount: null,
};
const update = {
  name: create.name,
  kind: create.kind,
  baseUrl: create.baseUrl,
};
export const providerManagementWireFixtures = {
  encryptedModelProviderCreateSchema: [
    create,
    { ...create, protectedApiKey: policyEnvelope },
    { ...create, kind: "chatgpt", initialAccount: account },
    {
      ...create,
      kind: "grok",
      initialAccount: account,
      weeklyUsageReservePercent: 0,
    },
  ],
  encryptedModelProviderUpdateSchema: [
    update,
    { ...update, protectedApiKey: null, weeklyUsageReservePercent: 100 },
    { ...update, protectedApiKey: policyEnvelope },
  ],
  modelProviderWireSummarySchema: [
    {
      ...update,
      id: create.id,
      hasApiKey: false,
      createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
    },
  ],
};
export function* providerManagementWireCases(name) {
  if (name === "encryptedModelProviderCreateSchema") {
    for (const kind of ["openai-compatible", "ollama", "chatgpt", "grok"])
      for (const initialAccount of [undefined, null, account, {}, [], false])
        yield { ...create, kind, initialAccount };
    for (const length of [0, 1, 80, 81])
      yield { ...create, name: "x".repeat(length) };
    yield { ...create, name: " \ufeff \ud800 " };
    yield { ...create, protectedApiKey: policyEnvelope, apiKey: "plaintext" };
  }
  if (name === "encryptedModelProviderUpdateSchema") {
    yield { ...update, id: create.id };
    yield { ...update, initialAccount: account };
    yield { ...update, protectedApiKey: { ...policyEnvelope, keyRevision: 0 } };
    for (const weeklyUsageReservePercent of [null, -1, 0, 0.5, 3, 100, 101])
      yield { ...update, weeklyUsageReservePercent };
  }
  if (name === "modelProviderWireSummarySchema") {
    yield {
      ...providerManagementWireFixtures[name][0],
      protectedApiKey: policyEnvelope,
    };
    yield { ...providerManagementWireFixtures[name][0], apiKey: "plaintext" };
  }
}
