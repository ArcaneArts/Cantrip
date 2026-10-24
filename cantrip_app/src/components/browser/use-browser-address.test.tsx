import TestRenderer, { act } from "react-test-renderer";
import { expect, it } from "vitest";
import { useBrowserAddress } from "./use-browser-address";

it("preserves an unfinished address through page updates until explicit navigation or cancellation", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let value!: ReturnType<typeof useBrowserAddress>;
  function Harness() {
    value = useBrowserAddress("https://initial.example/");
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<Harness />);
  });
  await act(async () => value.followPage("https://redirect.example/"));
  expect(value.address).toBe("https://redirect.example/");
  await act(async () => value.edit("unfinished address"));
  await act(async () => value.followPage("https://background.example/"));
  expect(value.address).toBe("unfinished address");
  await act(async () => value.commit("https://chosen.example/"));
  await act(async () => value.followPage("https://next.example/"));
  expect(value.address).toBe("https://next.example/");
  await act(async () => value.edit(""));
  await act(async () => value.followPage("https://ignored.example/"));
  expect(value.address).toBe("");
  await act(async () => tree.unmount());
});
