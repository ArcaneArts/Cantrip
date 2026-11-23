// Keep the reviewed legacy classification assertions as compatibility evidence,
// then exercise current native authority. A frozen Node implementation cannot
// establish current Rust ownership, session or encryption behavior.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rustEnvironment, repositoryRoot } from "./server-rust/cargo.mjs";

async function run(command, args, env = process.env) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Boundary validation failed (${code ?? signal}).`));
    });
  });
}

await run(process.execPath, [
  fileURLToPath(
    new URL("./audit-reference-server-boundaries.mjs", import.meta.url),
  ),
  ...process.argv.slice(2),
]);
const environment = await rustEnvironment();
for (const [suite, filter] of [
  ["auth_repository", "native_authentication_state_survives_process_restart"],
  [
    "encryption_repository",
    "native_registry_transactions_ownership_and_retained_state",
  ],
  [
    "http_security_boundaries",
    "current_native_http_authority_isolated_from_reference_server",
  ],
]) {
  await run(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      "cantrip_server_rs/Cargo.toml",
      "--test",
      suite,
      filter,
      "--",
      "--exact",
    ],
    environment,
  );
}
console.log(
  "Current Rust HTTP, session, owner, registry and retained-state boundaries pass; legacy classification assertions retained separately.",
);
