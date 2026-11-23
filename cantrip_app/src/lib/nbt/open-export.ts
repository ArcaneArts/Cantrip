import { isTauri } from "@tauri-apps/api/core";
import { Capacitor } from "@capacitor/core";
import type { OpenNbtExportSink } from "./export-copy";
import { openNativeNbtExport } from "./native-export";
import { openPickerNbtExport, type NbtSavePicker } from "./picker-export";
import { openDownloadNbtExport } from "./download-export";
import { openMobileNbtExport } from "./mobile-export";

export const openNbtExport: OpenNbtExportSink = (input, signal) => {
  // Encoding normalizes unpaired UTF-16 surrogates before RFC5987 headers.
  const candidate = new TextDecoder().decode(
    new TextEncoder().encode(
      input
        .split(/[\\/]/u)
        .at(-1)
        ?.replace(/[\u0000-\u001f\u007f]/gu, "") || "document.nbt",
    ),
  );
  const name =
    candidate === "." || candidate === ".." ? "document.nbt" : candidate;
  if (name.length > 1024) throw new Error("The export filename is too long.");
  if (isTauri()) return openNativeNbtExport(name, signal);
  if (Capacitor.isNativePlatform()) return openMobileNbtExport(name, signal);
  const picker = (window as unknown as { showSaveFilePicker?: NbtSavePicker })
    .showSaveFilePicker;
  if (picker) return openPickerNbtExport(picker.bind(window), name, signal);
  return openDownloadNbtExport(name, signal);
};
