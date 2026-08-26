# `@cantrip/glitch`

Internal Cantrip package for the reusable glitch reveal engine and React
surface. It owns configuration normalization, frame and sequence generation,
visibility-aware staggering, the `EliteReveal` component, and the reveal CSS.

```tsx
import { DEFAULT_ELITE_REVEAL_CONFIG, EliteReveal } from "@cantrip/glitch";

<EliteReveal
  config={DEFAULT_ELITE_REVEAL_CONFIG}
  contentKind="text"
  replayKey={0}
>
  Cantrip
</EliteReveal>;
```

The stylesheet is loaded by the package entry point. Hosts provide the Cantrip
design tokens used by the effect, including `--primary` and `--background`.
Host-specific discovery policies and renderer adapters remain in their owning
applications.
