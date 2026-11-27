import SiClaude from "@icons-pack/react-simple-icons/icons/SiClaude";
import SiLmstudio from "@icons-pack/react-simple-icons/icons/SiLmstudio";
import SiOllama from "@icons-pack/react-simple-icons/icons/SiOllama";
import SiOpenrouter from "@icons-pack/react-simple-icons/icons/SiOpenrouter";
import SiVllm from "@icons-pack/react-simple-icons/icons/SiVllm";
import { Plug } from "lucide-react";

import grokLogo from "./provider-logos/grok.svg";
import liteLlmLightLogo from "./provider-logos/litellm-blue.svg";
import liteLlmDarkLogo from "./provider-logos/litellm-white.svg";
import llamaDarkLogo from "./provider-logos/llama-dark.svg";
import llamaLightLogo from "./provider-logos/llama-light.svg";
import mlxDarkLogo from "./provider-logos/mlx-dark.svg";
import mlxLightLogo from "./provider-logos/mlx.svg";
import openAiLogo from "./provider-logos/openai.svg";
import unslothLogo from "./provider-logos/unsloth.svg";
import xaiLogo from "./provider-logos/xai.svg";
import zaiLogo from "./provider-logos/zai.svg";
import type { ProviderSetupKind } from "./provider-setup";

type ProviderMark =
  { light: string; dark?: string } | typeof SiOllama | typeof Plug;

const providerMarks: Record<ProviderSetupKind, ProviderMark> = {
  ollama: SiOllama,
  "lm-studio": SiLmstudio,
  "llama-cpp": { light: llamaLightLogo, dark: llamaDarkLogo },
  vllm: SiVllm,
  unsloth: { light: unslothLogo },
  litellm: { light: liteLlmLightLogo, dark: liteLlmDarkLogo },
  "mlx-lm": { light: mlxLightLogo, dark: mlxDarkLogo },
  openrouter: SiOpenrouter,
  zai: { light: zaiLogo },
  xai: { light: xaiLogo },
  openai: { light: openAiLogo },
  "openai-compatible": Plug,
  chatgpt: { light: openAiLogo },
  grok: { light: grokLogo },
  "claude-code": SiClaude,
};

export function ProviderSetupIcon({ setup }: { setup: ProviderSetupKind }) {
  const Mark = providerMarks[setup];
  return (
    <span
      data-slot="provider-setup-icon"
      aria-hidden="true"
      className="grid size-4 shrink-0 place-items-center"
    >
      {"light" in Mark ? (
        <>
          <img
            alt=""
            src={Mark.light}
            className={
              Mark.dark
                ? "size-full object-contain dark:hidden"
                : "size-full object-contain dark:invert"
            }
          />
          {Mark.dark ? (
            <img
              alt=""
              src={Mark.dark}
              className="hidden size-full object-contain dark:block"
            />
          ) : null}
        </>
      ) : (
        <Mark size={16} />
      )}
    </span>
  );
}
