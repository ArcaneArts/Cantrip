import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSettingsSlashCommands } from "./use-settings-slash-commands";

describe("local settings commands", () => {
  let renderer: ReactTestRenderer;
  let state: ReturnType<typeof useSettingsSlashCommands> & {
    draft: string;
    notice: string | null;
    setDraft(text: string): void;
  };
  const send = vi.fn();
  const dismissMenu = vi.fn();
  const consumeDraft = vi.fn();

  function Composer({
    chatId = "chat-a",
    modelPending = false,
    relocationActive = false,
    enabled = true,
  } = {}) {
    const [draft, setDraft] = useState("");
    const [notice, setNotice] = useState<string | null>(null);
    const commands = useSettingsSlashCommands({
      chatId,
      draft,
      enabled,
      modelPending,
      relocationActive,
      consumeDraft: () => {
        consumeDraft();
        setDraft("");
      },
      dismissMenu,
      notice: setNotice,
    });
    state = { ...commands, draft, setDraft, notice };
    return (
      <form
        onSubmit={() => {
          if (!commands.runSettingsCommand(draft)) send(draft);
        }}
      />
    );
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    await act(async () => {
      renderer = create(<Composer />);
    });
  });
  afterEach(async () => {
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  async function submit(text: string) {
    await act(async () => state.setDraft(text));
    await act(async () => renderer.root.findByType("form").props.onSubmit());
  }

  it.each(["model", "permissions"])(
    "opens /%s from direct submission without sending a prompt",
    async (name) => {
      await submit(` /${name} \n`);
      expect(state.settingsPicker).toBe(name);
      expect(state.draft).toBe("");
      expect(consumeDraft).toHaveBeenCalledOnce();
      expect(dismissMenu).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      expect(state.notice).toBeNull();
    },
  );

  it("shares picker state between palette and toolbar, and closes on chat change", async () => {
    await act(async () => {
      state.runSettingsCommand("/model");
    });
    expect(state.settingsPicker).toBe("model");
    await act(async () => state.setSettingsPicker(null));
    expect(state.settingsPicker).toBeNull();
    await act(async () => state.setSettingsPicker("permissions"));
    expect(state.settingsPicker).toBe("permissions");
    await act(async () => renderer.update(<Composer chatId="chat-b" />));
    expect(state.settingsPicker).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["/model other-model", "/permissions unrestricted"])(
    "keeps unsupported %s local and preserves the draft",
    async (text) => {
      await submit(text);
      expect(state.settingsPicker).toBeNull();
      expect(state.notice).toContain("without arguments");
      expect(state.draft).toBe(text);
      expect(consumeDraft).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("does not fall through to sending while a model save or relocation is pending", async () => {
    await act(async () => renderer.update(<Composer modelPending />));
    await submit("/model");
    expect(state.draft).toBe("/model");
    expect(state.settingsPicker).toBeNull();
    await act(async () => renderer.update(<Composer relocationActive />));
    await submit("/permissions");
    expect(state.draft).toBe("/permissions");
    expect(state.settingsPicker).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(consumeDraft).not.toHaveBeenCalled();
  });

  it("leaves ordinary prompts and unsupported surfaces to their normal handler", async () => {
    await submit("Please explain /model");
    expect(send).toHaveBeenLastCalledWith("Please explain /model");
    await act(async () => renderer.update(<Composer enabled={false} />));
    await submit("/model");
    expect(send).toHaveBeenLastCalledWith("/model");
    expect(state.settingsCommand).toBeNull();
    expect(state.settingsPicker).toBeNull();
    expect(consumeDraft).not.toHaveBeenCalled();
  });
});
