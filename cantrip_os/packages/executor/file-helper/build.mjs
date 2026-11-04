import { fileURLToPath } from "node:url";
import path from "node:path";
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../../..");
const { build } = await import(
  process.env.CANTRIP_OS_ESBUILD_MODULE ?? "esbuild"
);
await build({
  entryPoints: [path.join(directory, "main.ts")],
  outfile:
    process.argv[2] ??
    path.join(root, "cantrip_os/.build/file-helper/file-operations.mjs"),
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
});
