import {
  ArrowRight,
  Bot,
  Box,
  Braces,
  Check,
  ChevronRight,
  CirclePause,
  Cloud,
  Code2,
  Columns3,
  Command,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitPullRequest,
  Globe2,
  Laptop,
  ListTodo,
  Moon,
  PanelLeft,
  Play,
  Route,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  TerminalSquare,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

type ThemeMode = "system" | "light" | "dark";
type DemoTab = "chat" | "terminal" | "git";

const GITHUB_URL = "https://github.com/ArcaneArts/Cantrip";

const surfaces: Array<{
  description: string;
  icon: LucideIcon;
  title: string;
}> = [
  {
    icon: TerminalSquare,
    title: "Real terminals",
    description: "Worker-owned PTYs, right beside the agent doing the work.",
  },
  {
    icon: FileCode2,
    title: "Files & code",
    description:
      "Explore source, preview Markdown, and open the full Cantrip Code editor.",
  },
  {
    icon: Globe2,
    title: "Browser tabs",
    description:
      "Keep project pages and worker-streamed browser sessions in context.",
  },
  {
    icon: Laptop,
    title: "Remote desktop",
    description: "Reach the worker screen when a task needs a human hand.",
  },
];

const agentFeatures = [
  "Per-message Default, Plan, and Goal modes",
  "Steer a running turn or line up prompt queues",
  "Pause automation without losing buffered work",
  "Structured plans, reasoning, tools, and usage",
  "Live linked Codex console whenever you want it",
  "Fork, rename, duplicate, and compact chats",
];

const routes = [
  { label: "ChatGPT account A", state: "Preferred", tone: "cyan" },
  { label: "ChatGPT account B", state: "Fallback", tone: "violet" },
  { label: "OpenRouter / API", state: "Fallback", tone: "lime" },
];

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("cantrip-site-theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = resolveTheme(mode);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    apply();
    if (mode === "system") media.addEventListener("change", apply);
    localStorage.setItem("cantrip-site-theme", mode);

    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return { mode, setMode };
}

function ThemeSettings({
  mode,
  setMode,
}: {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const choices: Array<{ icon: LucideIcon; label: string; value: ThemeMode }> =
    [
      { icon: Laptop, label: "System", value: "system" },
      { icon: Sun, label: "Light", value: "light" },
      { icon: Moon, label: "Dark", value: "dark" },
    ];

  return (
    <div className="theme-settings" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Open appearance settings"
        className="icon-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? <X size={18} /> : <Settings2 size={18} />}
      </button>
      {open && (
        <div
          aria-label="Appearance settings"
          className="settings-popover"
          role="dialog"
        >
          <div className="settings-heading">
            <span>Appearance</span>
            <small>Default follows your system</small>
          </div>
          <div className="theme-options">
            {choices.map(({ icon: Icon, label, value }) => (
              <button
                aria-pressed={mode === value}
                className="theme-option"
                key={value}
                onClick={() => setMode(value)}
                type="button"
              >
                <Icon size={17} />
                <span>{label}</span>
                {mode === value && <Check className="option-check" size={15} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Brand() {
  return (
    <a aria-label="Cantrip home" className="brand" href="#top">
      <span className="brand-mark" aria-hidden="true">
        <Sparkles size={19} />
      </span>
      <span>CANTRIP</span>
    </a>
  );
}

function ChatDemo() {
  return (
    <div className="demo-pane chat-demo">
      <div className="message message-user">
        <span>YOU</span>
        <p>Ship the Git view cleanup in an isolated worktree.</p>
      </div>
      <div className="message message-agent">
        <span>CANTRIP / CODEX</span>
        <p>
          I’ll unify History, Issues, and PRs, then verify the affected flows.
        </p>
        <div className="plan-row">
          <Check size={14} />
          <span>Created agent/manual/unified-git</span>
        </div>
        <div className="plan-row active">
          <Play size={12} fill="currentColor" />
          <span>Implement unified Git surface</span>
        </div>
        <div className="plan-row">
          <span className="step-dot" />
          <span>Run checks and open PR</span>
        </div>
      </div>
      <div className="composer-demo">
        <span className="mode-chip">
          <ListTodo size={13} /> Goal
        </span>
        <span className="composer-placeholder">Steer the task…</span>
        <Command size={15} />
      </div>
    </div>
  );
}

function TerminalDemo() {
  return (
    <div className="demo-pane terminal-demo">
      <div>
        <span className="prompt">❯</span> git worktree list
      </div>
      <div className="muted-line">
        /workspace/Cantrip&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[main]
      </div>
      <div className="muted-line">
        /worktrees/unified-git&nbsp;&nbsp;[agent/manual/unified-git]
      </div>
      <br />
      <div>
        <span className="prompt">❯</span> pnpm --filter @cantrip/app test
      </div>
      <div className="terminal-pass">✓ 106 tests passed</div>
      <div>
        <span className="prompt">❯</span> <span className="cursor-block" />
      </div>
    </div>
  );
}

function GitDemo() {
  return (
    <div className="demo-pane git-demo">
      <div className="git-toolbar">
        <div className="git-tabs">
          <strong>History</strong>
          <span>Issues</span>
          <span>PRs</span>
        </div>
        <button aria-label="Pull from remote" type="button">
          <GitPullRequest size={14} /> Pull
        </button>
      </div>
      {[
        ["c91e42a", "Unify Git surfaces", "2m"],
        ["83dd102", "Keep queues paused between turns", "18m"],
        ["f4a20b8", "Add per-message goal mode", "1h"],
        ["a6001cd", "Initialize linked Codex console", "3h"],
      ].map(([hash, title, time], index) => (
        <div className="commit-row" key={hash}>
          <span className={`commit-node node-${index}`} />
          <div>
            <strong>{title}</strong>
            <small>{hash} · agent/manual</small>
          </div>
          <time>{time}</time>
        </div>
      ))}
    </div>
  );
}

function ProductDemo() {
  const [active, setActive] = useState<DemoTab>("chat");
  const tabs: Array<{ icon: LucideIcon; label: string; value: DemoTab }> = [
    { icon: Bot, label: "Chat", value: "chat" },
    { icon: TerminalSquare, label: "Terminal", value: "terminal" },
    { icon: GitBranch, label: "Git", value: "git" },
  ];

  return (
    <div
      className="product-stage"
      aria-label="Interactive Cantrip interface preview"
    >
      <div className="window-chrome">
        <div className="traffic-lights">
          <i />
          <i />
          <i />
        </div>
        <span>ArcaneArts / Cantrip</span>
        <span className="online">
          <i /> worker online
        </span>
      </div>
      <div className="product-body">
        <aside className="demo-sidebar">
          <div className="sidebar-logo">
            <Sparkles size={16} />
          </div>
          <button aria-label="Workspace" type="button">
            <PanelLeft size={16} />
          </button>
          <button aria-label="Code" type="button">
            <Code2 size={16} />
          </button>
          <button aria-label="Branches" type="button">
            <GitBranch size={16} />
          </button>
          <span />
          <button aria-label="Settings" type="button">
            <Settings2 size={16} />
          </button>
        </aside>
        <main className="demo-main">
          <div
            className="demo-tabs"
            role="tablist"
            aria-label="Preview surface"
          >
            {tabs.map(({ icon: Icon, label, value }) => (
              <button
                aria-selected={active === value}
                className={active === value ? "active" : ""}
                key={value}
                onClick={() => setActive(value)}
                role="tab"
                type="button"
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          {active === "chat" && <ChatDemo />}
          {active === "terminal" && <TerminalDemo />}
          {active === "git" && <GitDemo />}
        </main>
      </div>
      <div className="stage-orbit orbit-a">
        <Bot size={17} />
      </div>
      <div className="stage-orbit orbit-b">
        <GitBranch size={16} />
      </div>
      <div className="stage-note">
        <CirclePause size={14} /> Pauses at a safe boundary
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="section-label">
      <span />
      {children}
    </div>
  );
}

function App() {
  const { mode, setMode } = useTheme();

  return (
    <div className="site-shell" id="top">
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <nav aria-label="Primary navigation">
            <a href="#workspace">Workspace</a>
            <a href="#agents">Agents</a>
            <a href="#architecture">Architecture</a>
          </nav>
          <div className="header-actions">
            <ThemeSettings mode={mode} setMode={setMode} />
            <a
              className="github-link"
              href={GITHUB_URL}
              rel="noreferrer"
              target="_blank"
            >
              <GitPullRequest size={17} /> <span>GitHub</span>
            </a>
          </div>
        </div>
      </header>

      <main>
        <section className="hero section-wrap">
          <div className="hero-copy">
            <div className="status-line">
              <i /> LOCAL-FIRST · OPEN SOURCE · IN ACTIVE DEVELOPMENT
            </div>
            <h1>Run the whole build.</h1>
            <p className="hero-lede">
              Cantrip puts coding agents, real terminals, project files, Git,
              and the web in one calm command center.
            </p>
            <div className="hero-actions">
              <a
                className="button button-primary"
                href={GITHUB_URL}
                rel="noreferrer"
                target="_blank"
              >
                <GitPullRequest size={18} /> View on GitHub{" "}
                <ArrowRight size={16} />
              </a>
              <a className="button button-quiet" href="#workspace">
                Explore the workspace <ChevronRight size={16} />
              </a>
            </div>
            <div className="hero-proof">
              <div>
                <ShieldCheck size={17} />
                <span>
                  <strong>Your source stays on your worker.</strong>
                  <small>Cantrip coordinates it.</small>
                </span>
              </div>
              <div>
                <Braces size={17} />
                <span>
                  <strong>Powered by Codex CLI.</strong>
                  <small>Structured or live.</small>
                </span>
              </div>
            </div>
          </div>
          <ProductDemo />
        </section>

        <section className="workspace-section section-wrap" id="workspace">
          <div className="section-heading split-heading">
            <div>
              <SectionLabel>ONE WORKSPACE</SectionLabel>
              <h2>Every surface the work touches.</h2>
            </div>
            <p>
              Move between an agent and its environment without breaking context
              or reaching for another window.
            </p>
          </div>
          <div className="surface-grid">
            {surfaces.map(({ description, icon: Icon, title }, index) => (
              <article
                className={`surface-card surface-${index + 1}`}
                key={title}
              >
                <div className="surface-icon">
                  <Icon size={21} />
                </div>
                <span className="surface-index">0{index + 1}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="agent-section section-wrap" id="agents">
          <div className="agent-panel">
            <div className="agent-copy">
              <SectionLabel>AGENT CONTROL</SectionLabel>
              <h2>More than a prompt box.</h2>
              <p>
                Give Codex the right operating mode for the next message, then
                stay in control while it works.
              </p>
              <ul className="feature-checks">
                {agentFeatures.map((feature) => (
                  <li key={feature}>
                    <Check size={15} />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mode-stack">
              <div className="mode-card mode-default">
                <div>
                  <Bot size={18} />
                  <span>Default</span>
                </div>
                <small>Move fast with the normal agent loop.</small>
                <span className="mode-key">⌘ ↵</span>
              </div>
              <div className="mode-card mode-plan">
                <div>
                  <ListTodo size={18} />
                  <span>Plan</span>
                </div>
                <small>Think together. Questions wait for you.</small>
                <span className="mode-key">ASK</span>
              </div>
              <div className="mode-card mode-goal">
                <div>
                  <Sparkles size={18} />
                  <span>Goal</span>
                </div>
                <small>Keep advancing toward a durable objective.</small>
                <span className="mode-key">RUN</span>
              </div>
              <div className="pause-line">
                <CirclePause size={16} /> Pause after the current safe boundary
              </div>
            </div>
          </div>
        </section>

        <section className="git-section section-wrap">
          <div className="git-visual" aria-hidden="true">
            <div className="branch-map">
              <div className="branch-row primary">
                <span />
                <strong>Primary</strong>
                <small>main · clean</small>
              </div>
              <div className="branch-connector" />
              <div className="branch-row agent">
                <span />
                <strong>Agent worktree</strong>
                <small>feat/git-view · 3 changes</small>
              </div>
              <div className="branch-connector short" />
              <div className="branch-row agent second">
                <span />
                <strong>Agent worktree</strong>
                <small>fix/queue-pause · checks passing</small>
              </div>
            </div>
            <div className="pr-card">
              <GitPullRequest size={20} />
              <div>
                <span>Pull request ready</span>
                <small>Isolated, reviewed, reversible.</small>
              </div>
              <Check size={16} />
            </div>
          </div>
          <div className="git-copy">
            <SectionLabel>GIT, BUILT IN</SectionLabel>
            <h2>Let agents work in parallel—not on top of each other.</h2>
            <p>
              Cantrip understands branches, worktrees, staged and unstaged
              changes, history, issues, and pull requests. Keep Primary calm
              while every task gets its own lane.
            </p>
            <div className="inline-features">
              <span>
                <GitBranch size={16} /> Agent-managed worktrees
              </span>
              <span>
                <GitPullRequest size={16} /> Unified Git surface
              </span>
              <span>
                <ShieldCheck size={16} /> Guarded operations
              </span>
            </div>
          </div>
        </section>

        <section className="routing-section section-wrap">
          <div className="section-heading split-heading">
            <div>
              <SectionLabel>MODEL ROUTING</SectionLabel>
              <h2>Choose the model. Keep an escape route.</h2>
            </div>
            <p>
              Compose logical model profiles from ChatGPT accounts,
              OpenAI-compatible APIs, and local Ollama endpoints.
            </p>
          </div>
          <div className="routing-board">
            <div className="route-source">
              <div className="profile-icon">
                <Sparkles size={22} />
              </div>
              <span>Model profile</span>
              <strong>Best available</strong>
              <small>Reasoning: high</small>
            </div>
            <div className="route-lines" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="route-destinations">
              {routes.map((route) => (
                <div className="route-row" key={route.label}>
                  <span className={`route-dot ${route.tone}`} />
                  <strong>{route.label}</strong>
                  <small>{route.state}</small>
                </div>
              ))}
            </div>
            <div className="route-callout">
              <Route size={16} /> Cantrip records the route used for every turn.
            </div>
          </div>
        </section>

        <section
          className="architecture-section section-wrap"
          id="architecture"
        >
          <div className="architecture-copy">
            <SectionLabel>SELF-HOSTABLE BY DESIGN</SectionLabel>
            <h2>One control plane. Workers where the code lives.</h2>
            <p>
              The React client talks to a Fastify server, which routes work to
              independent Node workers. Files and runtime state stay with the
              machine that owns them.
            </p>
            <a
              href={`${GITHUB_URL}#architecture`}
              rel="noreferrer"
              target="_blank"
            >
              Read the architecture <ExternalLink size={15} />
            </a>
          </div>
          <div className="architecture-map">
            <div className="arch-node clients">
              <Columns3 size={20} />
              <span>Clients</span>
              <small>Web · Desktop · Mobile path</small>
            </div>
            <div className="arch-link">
              <i />
              <span>HTTP + WS</span>
            </div>
            <div className="arch-node server">
              <Cloud size={20} />
              <span>Server</span>
              <small>History · Identity · Routing</small>
            </div>
            <div className="arch-link">
              <i />
              <span>Worker channel</span>
            </div>
            <div className="arch-workers">
              <div className="arch-node worker">
                <Box size={18} />
                <span>Worker 01</span>
                <small>Codex · Git · PTY</small>
              </div>
              <div className="arch-node worker">
                <Box size={18} />
                <span>Worker 02</span>
                <small>Codex · Files · Web</small>
              </div>
            </div>
          </div>
        </section>

        <section className="closing-section section-wrap">
          <div className="closing-mark">
            <Sparkles size={29} />
          </div>
          <SectionLabel>THE WORKSPACE IS THE INTERFACE</SectionLabel>
          <h2>
            Give your agents somewhere
            <br />
            serious to work.
          </h2>
          <p>Cantrip is open source and under active development.</p>
          <a
            className="button button-primary"
            href={GITHUB_URL}
            rel="noreferrer"
            target="_blank"
          >
            <GitPullRequest size={18} /> Explore Cantrip{" "}
            <ArrowRight size={16} />
          </a>
        </section>
      </main>

      <footer className="site-footer">
        <div className="section-wrap footer-inner">
          <Brand />
          <p>Local-first tools for ambitious builds.</p>
          <div>
            <a href={GITHUB_URL} rel="noreferrer" target="_blank">
              GitHub
            </a>
            <a
              href={`${GITHUB_URL}/blob/main/README.md`}
              rel="noreferrer"
              target="_blank"
            >
              Docs
            </a>
          </div>
          <small>© {new Date().getFullYear()} Arcane Arts</small>
        </div>
      </footer>
    </div>
  );
}

export default App;
