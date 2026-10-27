// Development export only. The server embeds these public templates and limits.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import * as protocol from "../../packages/protocol/dist/policies.js";
import { parsePolicyTemplateMarkdownCollection } from "../../packages/protocol/dist/policy-template-markdown.js";
const directory = new URL("../../policy_templates/", import.meta.url);
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".md"))
  .sort();
const contents = Object.fromEntries(
  await Promise.all(
    files.map(async (name) => [
      name,
      await readFile(new URL(name, directory), "utf8"),
    ]),
  ),
);
export const assets = {
  policyLimit: protocol.POLICY_LIMIT,
  effectivePolicyLimit: protocol.EFFECTIVE_POLICY_LIMIT,
  bootstrapVersion: protocol.POLICY_BOOTSTRAP_VERSION,
  templates: parsePolicyTemplateMarkdownCollection(contents),
  sources: Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [
      name,
      createHash("sha256").update(text).digest("hex"),
    ]),
  ),
};
if (process.argv.includes("--write")) {
  const target = new URL(
    "../../cantrip_server_rs/contracts/policies.json",
    import.meta.url,
  );
  await writeFile(
    target,
    await format(JSON.stringify(assets), {
      ...(await resolveConfig(fileURLToPath(target))),
      parser: "json",
    }),
  );
} else if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(assets));
}
