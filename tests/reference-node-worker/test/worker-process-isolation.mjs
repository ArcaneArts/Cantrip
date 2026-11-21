// Loaded only by the separate-process acceptance test. The production worker,
// transport, encryption, native engine, broker and command handlers stay intact.
// Desktop capture and CodeGraph installation are unrelated host side effects.
import { ManagedDesktopRemoteSurfaceAdapter } from "../dist/desktop/desktop-adapter.js";
import { CodeGraphRuntimeManager } from "../dist/codegraph/runtime.js";
ManagedDesktopRemoteSurfaceAdapter.prototype.initialize = async function () {};
CodeGraphRuntimeManager.prototype.prepare = async function () {
  throw new Error(
    "CodeGraph installation is isolated in worker restart acceptance.",
  );
};
