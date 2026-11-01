import { expect, it } from "vitest";
import {
  FILE_VIEWERS,
  resolveFileViewer,
  type FileViewerDefinition,
} from "./file-viewers";
import { mediaBlobForViewer } from "./viewer-media";

it.each([
  ["world.nbt", "nbt", "preview"],
  ["data.nbt.gz", "nbt", "preview"],
  ["level.dat", "nbt", "preview"],
  ["level.dat_old", "nbt", "preview"],
  ["build.litematic", "nbt", "preview"],
  ["arbitrary.dat", "text", "edit"],
  ["photo.PNG", "image", "preview"],
  ["song.ogg", "audio", "preview"],
  ["clip.mp4", "video", "preview"],
  ["README.md", "markdown", "preview"],
  ["LICENSE.md", "license", "preview"],
  ["daemon.log.2", "log", "preview"],
  ["settings.json", "json", "edit"],
  ["config.yml", "yaml", "edit"],
  ["Cargo.toml", "toml", "edit"],
  [".env", "env", "edit"],
  ["unknown.xyz", "text", "edit"],
])("preserves automatic detection for %s", (path, id, mode) => {
  expect(resolveFileViewer(path)).toMatchObject({
    definition: { id },
    mode,
    unavailable: null,
  });
});
it("forces the chosen reader and syntax independently of the filename", () => {
  expect(resolveFileViewer("photo.png", "text")).toMatchObject({
    media: null,
    mode: "edit",
    syntaxPath: "viewer.txt",
  });
  expect(resolveFileViewer("opaque.xyz", "json")).toMatchObject({
    structuredFormat: "json",
    mode: "visual",
    syntaxPath: "viewer.json",
  });
  expect(resolveFileViewer("opaque.xyz", "image")).toMatchObject({
    media: { kind: "image" },
    mode: "preview",
  });
  expect(resolveFileViewer("daemon.log", "text").log).toBe(false);
  expect(resolveFileViewer("LICENSE.md", "markdown").license).toBe(false);
  expect(resolveFileViewer("README.md", "text").markdown).toBe(false);
});
it("supports a custom protected-data viewer through the same registry", () => {
  const Component = () => null;
  const custom: FileViewerDefinition = {
    id: "example-binary",
    label: "Example binary",
    icon: "file",
    defaultMode: "preview",
    matches: (path) => path.endsWith(".example"),
    Component,
  };
  const registry = [custom, ...FILE_VIEWERS];
  expect(resolveFileViewer("source.example", null, registry).custom).toBe(
    Component,
  );
  expect(
    resolveFileViewer("opaque.xyz", "example-binary", registry).custom,
  ).toBe(Component);
  expect(
    resolveFileViewer("source.example", "text", registry).custom,
  ).toBeUndefined();
  expect(resolveFileViewer("file.txt", "future-viewer").unavailable).toBe(
    "future-viewer",
  );
});
it("uses concrete SVG and JPEG MIME types when forcing unfamiliar filenames", async () => {
  expect(
    (
      await mediaBlobForViewer(
        new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>']),
        "image",
        "image/png",
      )
    ).type,
  ).toBe("image/svg+xml");
  expect(
    (
      await mediaBlobForViewer(
        new Blob([new Uint8Array([0xff, 0xd8, 0xff])]),
        "image",
        "image/png",
      )
    ).type,
  ).toBe("image/jpeg");
});

it.each([
  ["OggS", "audio/ogg"],
  ["fLaC", "audio/flac"],
  ["RIFF0000WAVE", "audio/wav"],
])("recognizes forced audio from %s bytes", async (prefix, mime) => {
  expect(
    (await mediaBlobForViewer(new Blob([prefix]), "audio", "audio/mpeg")).type,
  ).toBe(mime);
});

it("offers NBT for ambiguous extensions without routing through text decoding", () => {
  const result = resolveFileViewer("unknown.xyz", "nbt");
  expect(result.definition.id).toBe("nbt");
  expect(result.custom).toBeTypeOf("function");
  expect(result.mode).toBe("preview");
  expect(result.media).toBeNull();
});
