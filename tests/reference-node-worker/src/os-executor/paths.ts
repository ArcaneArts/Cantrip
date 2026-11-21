import { cantripOsGuestPathSchema } from "@cantrip/protocol";

/** Encode a Linux address without applying the worker host's path semantics. */
export function guestFileUri(path: string): string {
  const absolute = cantripOsGuestPathSchema.parse(path);
  return new URL(
    "file://" + absolute.split("/").map(encodeURIComponent).join("/"),
  ).href;
}

export function guestPathFromFileUri(value: string): string {
  const uri = new URL(value);
  if (uri.protocol !== "file:" || uri.hostname || uri.search || uri.hash)
    throw new Error("Expected a local Linux guest file URI.");
  return cantripOsGuestPathSchema.parse(decodeURIComponent(uri.pathname));
}
