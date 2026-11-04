import { fileURLToPath } from "node:url";
import path from "node:path";
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../../..");
const { build } = await import(
  process.env.CANTRIP_OS_ESBUILD_MODULE ?? "esbuild"
);
const options = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  nodePaths: process.env.CANTRIP_OS_HELPER_NODE_PATH
    ? [process.env.CANTRIP_OS_HELPER_NODE_PATH]
    : [path.join(root, "packages/protocol/node_modules")],
  plugins: [
    {
      name: "cantrip-shared-sources",
      setup(builder) {
        builder.onResolve({ filter: /^@cantrip\// }, ({ path: specifier }) => {
          const [, name, ...parts] = specifier.split("/");
          if (!["protocol", "crypto"].includes(name))
            throw new Error(
              `Unexpected guest file helper dependency: ${specifier}`,
            );
          return {
            path: path.join(
              root,
              "packages",
              name,
              "src",
              parts.length ? parts.join("/") + ".ts" : "index.ts",
            ),
          };
        });
      },
    },
  ],
};
const output =
  process.argv[2] ??
  path.join(root, "cantrip_os/.build/file-helper/file-operations.mjs");
await build({
  ...options,
  entryPoints: [path.join(directory, "main.ts")],
  outfile: output,
});
await build({
  ...options,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  entryPoints: [path.join(directory, "run-definitions.ts")],
  outfile: path.join(path.dirname(output), "run-definitions.mjs"),
});
