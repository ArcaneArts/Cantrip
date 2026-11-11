import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { codexAccountHome } from "../../cantrip_worker/src/codex/account-home.ts";
import { eventually } from "./full-worker.mjs";

const signedOut = {
  authenticated: false,
  authMode: null,
  email: null,
  planType: null,
  weeklyUsage: null,
  loginPending: false,
  loginError: null,
};
const authCommand = /operation=((?:codex|provider)\.auth\.[\w.]+)\b/;

export async function actualProviderAuthClient({
  page,
  workerId,
  workerDirectory,
  diagnostics,
  result,
}) {
  const api = (operation, ...args) =>
    page.evaluate(
      async ({ operation, args }) =>
        (await import("/src/lib/api/models.ts"))[operation](...args),
      { operation, args },
    );
  const commands = (event) =>
    diagnostics()
      .split("\n")
      .filter((line) => line.includes(`event=worker.command.${event} `))
      .flatMap((line) => line.match(authCommand)?.[1] ?? []);
  const summary = (result.providerAuth = []);
  for (const kind of ["chatgpt", "grok"]) {
    const provider = await api("createModelProvider", {
      name: `Disposable legacy ${kind} provider`,
      kind,
      baseUrl: "http://127.0.0.1:1",
    });
    const account = await api("createModelProviderAccount", provider.id, {
      label: "Legacy account to sign out",
    });
    const neighbor = await api("createModelProviderAccount", provider.id, {
      label: "Adjacent account to retain",
    });
    const canary = `synthetic-${kind}-local-only`;
    // The Codex file holds an API key, never an OAuth token. Grok has an old
    // unrecognized file shape. Neither can initiate a real provider revocation.
    const bytes = JSON.stringify(
      kind === "chatgpt"
        ? { auth_mode: "apikey", OPENAI_API_KEY: canary }
        : { fixture: canary },
    );
    const writeLocalCredential = async (accountId) => {
      const directory = codexAccountHome(workerDirectory, accountId);
      await mkdir(directory, { recursive: true });
      const file = path.join(
        directory,
        kind === "chatgpt" ? "auth.json" : "grok-auth.json",
      );
      await writeFile(file, bytes, { mode: 0o600 });
      return file;
    };
    const selectedFile = await writeLocalCredential(account.id);
    const retainedFile = await writeLocalCredential(neighbor.id);
    const dispatchedBefore = commands("dispatched").length;
    const completedBefore = commands("completed").length;

    const storedStatus = await api(
      "getCodexAuthStatus",
      provider.id,
      account.id,
    );
    assert.deepEqual(storedStatus, signedOut);
    assert.deepEqual(commands("dispatched").slice(dispatchedBefore), []);
    const workerStatus = await api(
      "getCodexAuthStatus",
      provider.id,
      account.id,
      workerId,
    );
    assert.deepEqual(workerStatus, {
      ...signedOut,
      loginError:
        "The worker's provider credential is invalid. Sign in again to replace it.",
    });
    assert.equal(await readFile(selectedFile, "utf8"), bytes);
    assert.deepEqual(commands("dispatched").slice(dispatchedBefore), [
      "provider.auth.legacy.capture",
    ]);

    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/codex/auth/logout" &&
          response.request().method() === "POST",
      ),
      api("logoutCodex", provider.id, account.id, workerId),
    ]);
    assert.equal(response.status(), 204);
    await assert.rejects(readFile(selectedFile), { code: "ENOENT" });
    assert.equal(await readFile(retainedFile, "utf8"), bytes);
    const after = await api("getCodexAuthStatus", provider.id, account.id);
    assert.deepEqual(after, signedOut);
    const accounts = await api("listModelProviderAccounts", provider.id);
    assert.equal(
      accounts.find((entry) => entry.id === account.id)?.credentialState,
      "signed-out",
    );
    assert.equal(
      accounts.find((entry) => entry.id === neighbor.id)?.label,
      neighbor.label,
    );
    const expected = [
      "provider.auth.legacy.capture",
      "provider.auth.legacy.capture",
      "codex.auth.logout",
      "provider.auth.account.clear",
    ];
    const completed = await eventually(
      () => commands("completed").slice(completedBefore),
      (observed) => assert.deepEqual(observed, expected),
    );
    assert.deepEqual(commands("dispatched").slice(dispatchedBefore), expected);
    assert.ok(!diagnostics().includes(canary));
    summary.push({
      kind,
      storedStatus,
      workerStatus,
      completed,
      after,
      selectedFileRemoved: true,
      adjacentFilePreserved: true,
    });
  }
  result.steps.push(
    "provider status reads stored state or requests legacy capture, then real account logout clears only the selected worker credential home",
  );
}
