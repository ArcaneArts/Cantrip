import { useCallback, useRef, useState } from "react";

/** Address drafts belong to the view, not to focus or streamed page metadata. */
export function useBrowserAddress(initialUrl: string) {
  const [address, setAddress] = useState(initialUrl);
  const dirty = useRef(false);
  const edit = useCallback((value: string) => {
    dirty.current = true;
    setAddress(value);
  }, []);
  const commit = useCallback((value: string) => {
    dirty.current = false;
    setAddress(value);
  }, []);
  const followPage = useCallback((url: string) => {
    if (!dirty.current) setAddress(url);
  }, []);
  const restore = useCallback((value: string, isDirty: boolean) => {
    dirty.current = isDirty;
    setAddress(value);
  }, []);
  const isDirty = useCallback(() => dirty.current, []);
  return { address, edit, commit, followPage, restore, isDirty };
}
