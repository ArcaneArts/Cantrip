// Controlled catalog/model facts over the unchanged production worker transport.
import assert from "node:assert/strict";
import {
  chatGptCatalogModel,
  grokCatalogModel,
  capturedCredentialFixture,
} from "./settings-provider-fixtures.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import { literal, json } from "./project-target-state.mjs";
import { taskTimestamp } from "./task-wire-fixtures.mjs";

export const providerStateKinds = ["chatgpt", "grok", "ollama"];
export const providerStateId = (kind) => "qualified-" + kind;
export const providerStateAccount = (kind) =>
  kind === "chatgpt"
    ? "77777777-7777-4777-8777-000000000601"
    : "77777777-7777-4777-8777-000000000602";
export function providerStateSeed(owner) {
  const rows = [];
  for (const [i, kind] of providerStateKinds.entries()) {
    rows.push(
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(providerStateId(kind))},${literal(owner)},${literal("Qualified " + kind)},${literal(kind)},'http://catalog.invalid')`,
    );
    if (kind !== "ollama") {
      const credential = capturedCredentialFixture(110 + i),
        account = providerStateAccount(kind);
      rows.push(
        `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,credential_state,protected_credential,credential_subject_blind_index,credential_revision) VALUES(${literal(account)},${literal(providerStateId(kind))},${json(policyEnvelope)},${literal("qualified-home-" + kind)},'signed-in',${json(credential.protectedCredential)},${literal(credential.subjectBlindIndex)},1)`,
      );
    }
  }
  return rows;
}
export function providerStateWorker(result) {
  const state = { revision: 0, fail: null };
  async function onCommand(command) {
    if (command.type === "model.provider.test") {
      assert.equal(command.provider.id, providerStateId("ollama"));
      result.catalogCommands.push(structuredClone(command));
      return { accepted: true, durationMs: 3 };
    }
    const kind = {
      "model.chatgpt.catalog": "chatgpt",
      "model.grok.catalog": "grok",
      "model.ollama.catalog": "ollama",
    }[command.type];
    if (!kind) return;
    assert.equal(command.provider.id, providerStateId(kind));
    if (kind !== "ollama") {
      assert.equal(command.provider.accountId, providerStateAccount(kind));
      assert.equal(
        command.provider.credentialHomeKey,
        "qualified-home-" + kind,
      );
    }
    result.catalogCommands.push(structuredClone(command));
    if (state.fail === kind)
      throw new Error("Controlled " + kind + " catalog failure");
    if (kind === "chatgpt")
      return {
        observedAt: taskTimestamp,
        models: [
          {
            ...chatGptCatalogModel,
            model: "gpt-first",
            displayName: "First GPT",
          },
          {
            ...chatGptCatalogModel,
            id: "second-gpt",
            model: "gpt-second",
            displayName: "Second GPT",
            isDefault: false,
            description: "Second revision " + state.revision + " 日本語 🌳",
          },
        ],
      };
    if (kind === "grok")
      return {
        observedAt: taskTimestamp,
        models: [
          {
            ...grokCatalogModel,
            rawMetadata: {
              10: "ten",
              2: "two",
              unicode: "日本語 🌳",
              public: true,
            },
          },
        ],
      };
    return {
      observedAt: taskTimestamp,
      models: [
        {
          name: "qualified-llama",
          modifiedAt: null,
          sizeBytes: 100,
          digest: "qualified-digest",
          family: "llama",
          families: ["llama"],
          parameterSize: "8B",
          quantization: "Q4",
          capabilities: ["TOOLS", "VISION", "THINKING"],
          modelInfo: {
            "general.architecture": "llama",
            "llama.context_length": 128000,
          },
        },
      ],
    };
  }
  return { state, onCommand };
}
