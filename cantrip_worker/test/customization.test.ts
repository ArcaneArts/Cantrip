import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { codexRuntimeReportSchema } from "@cantrip/protocol";

import {
  customizationCapabilities,
  customizationInventory,
  parseExternalImportStatus,
  parseExternalImportPreview,
  parseHookInventory,
  parseMcpOauthCompletion,
  parseMcpOauthStart,
  parseMcpResourceRead,
  parseMcpServerPage,
  parseSkillConfigResult,
  parseSkillInventory,
  resolveProjectSkillRoots,
  selectExternalImportItems,
  skillPathForConfiguration,
} from "../src/codex/customization.js";

const methods = {
  "collaborationMode/list": "available",
  "thread/goal/get": "available",
  "thread/goal/set": "available",
  "thread/goal/clear": "available",
  "hooks/list": "available",
  "skills/list": "available",
  "skills/config/write": "available",
  "skills/extraRoots/set": "available",
  "mcpServerStatus/list": "available",
  "mcpServer/oauth/login": "available",
  "mcpServer/resource/read": "available",
  "config/mcpServer/reload": "available",
  "plugin/list": "available",
  "plugin/read": "available",
  "plugin/install": "available",
  "plugin/uninstall": "available",
  "externalAgentConfig/detect": "available",
  "externalAgentConfig/import": "available",
} as const;

const report = codexRuntimeReportSchema.parse({
  adapter: "app-server",
  compatibility: "compatible",
  version: { raw: "codex-cli 0.153.1", semantic: "0.153.1" },
  testedRange: ">=0.153.0 <0.154.0",
  initialize: {
    userAgent: "codex_cli_rs/0.153.1",
    platformFamily: "unix",
    platformOs: "macos",
    experimentalApi: true,
  },
  methods,
  features: [
    { name: "goals", stage: "stable", enabled: true, defaultEnabled: true },
    { name: "hooks", stage: "stable", enabled: true, defaultEnabled: true },
    {
      name: "multi_agent",
      stage: "stable",
      enabled: true,
      defaultEnabled: true,
    },
    {
      name: "plugins",
      stage: "stable",
      enabled: true,
      defaultEnabled: true,
    },
  ],
  nativeSubagents: {
    available: true,
    protocolVersion: 1,
    reason: null,
  },
  degradedReasons: [],
});

describe("Codex customization inventory", () => {
  it("separates native method support from production stability policy", () => {
    const capabilities = customizationCapabilities(report);
    expect(capabilities).toMatchObject({
      isolatedCodexHome: true,
      nativeSubagents: { available: true, protocolVersion: 1 },
      customAgents: { available: false, stability: "unsupported" },
      skills: {
        list: { available: true },
        configure: { available: true },
      },
      plugins: {
        list: { available: false, stability: "unsupported" },
        install: { available: false, stability: "unsupported" },
      },
    });
    expect(capabilities.plugins.list.reason).toContain("not yet implemented");

    const newerSubagentProtocol = customizationCapabilities({
      ...report,
      nativeSubagents: {
        available: true,
        protocolVersion: 2,
        reason: null,
      },
    });
    expect(newerSubagentProtocol.nativeSubagents).toMatchObject({
      available: false,
      protocolVersion: null,
      reason: expect.stringContaining("protocol 2"),
    });

    const partial = customizationCapabilities({
      ...report,
      methods: { ...report.methods, "skills/config/write": "unavailable" },
    });
    expect(partial.skills.list.available).toBe(true);
    expect(partial.skills.configure.available).toBe(false);

    const missingRead = customizationCapabilities({
      ...report,
      methods: {
        ...report.methods,
        "skills/list": "unavailable",
        "externalAgentConfig/detect": "unavailable",
      },
    });
    expect(missingRead.skills.configure.available).toBe(false);
    expect(missingRead.externalImports.apply.available).toBe(false);
  });

  it("normalizes enabled and disabled skills with discovery errors", () => {
    expect(
      parseSkillInventory(
        {
          data: [
            {
              cwd: "/workspace/project",
              skills: [
                {
                  name: "review",
                  description: "Review changes",
                  interface: { displayName: "Review" },
                  path: "/workspace/project/.agents/skills/review/SKILL.md",
                  scope: "repo",
                  enabled: false,
                },
              ],
              errors: [
                { path: "broken/SKILL.md", message: "Invalid metadata" },
              ],
            },
          ],
        },
        "/workspace/project/.",
      ),
    ).toEqual({
      items: [
        {
          name: "review",
          description: "Review changes",
          displayName: "Review",
          path: "/workspace/project/.agents/skills/review/SKILL.md",
          scope: "repo",
          enabled: false,
        },
      ],
      errors: [{ path: "broken/SKILL.md", message: "Invalid metadata" }],
    });
  });

  it("configures only a skill path returned by the current project inventory", () => {
    const response = {
      data: [
        {
          cwd: "/workspace/project",
          skills: [
            {
              name: "review",
              description: "Review changes",
              path: "/workspace/project/.agents/skills/review/SKILL.md",
              scope: "repo",
              enabled: true,
            },
          ],
          errors: [],
        },
      ],
    };
    expect(
      skillPathForConfiguration(
        response,
        "/workspace/project",
        "/workspace/project/.agents/skills/review/../review/SKILL.md",
      ),
    ).toBe("/workspace/project/.agents/skills/review/SKILL.md");
    expect(() =>
      skillPathForConfiguration(
        response,
        "/workspace/project",
        "/workspace/other/SKILL.md",
      ),
    ).toThrow(/not present/u);
    expect(
      parseSkillConfigResult({ effectiveEnabled: false }, "skill/SKILL.md"),
    ).toEqual({ path: "skill/SKILL.md", effectiveEnabled: false });
  });

  it("canonicalizes and confines extra skill roots to the selected project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-skill-roots-"));
    try {
      const project = path.join(root, "project");
      const skills = path.join(project, "skills");
      const outside = path.join(root, "outside");
      await mkdir(skills, { recursive: true });
      await mkdir(outside);
      await symlink(
        outside,
        path.join(project, "linked-outside"),
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(
        resolveProjectSkillRoots(project, ["skills", "./skills"]),
      ).resolves.toEqual({ roots: [await realpath(skills)] });
      await expect(
        resolveProjectSkillRoots(project, ["../outside"]),
      ).rejects.toThrow(/within the selected project/u);
      await expect(
        resolveProjectSkillRoots(project, ["linked-outside"]),
      ).rejects.toThrow(/within the selected project/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves trusted hook inspection fields without executing hooks", () => {
    expect(
      parseHookInventory(
        {
          data: [
            {
              cwd: "/workspace/project",
              hooks: [
                {
                  key: "format",
                  eventName: "postToolUse",
                  handlerType: "command",
                  matcher: "apply_patch",
                  command: "pnpm format",
                  timeoutSec: 30,
                  statusMessage: "Formatting",
                  sourcePath: "/workspace/project/.codex/hooks.json",
                  source: "project",
                  pluginId: null,
                  enabled: true,
                  isManaged: false,
                  trustStatus: "trusted",
                },
              ],
              warnings: ["One legacy hook was ignored."],
              errors: [],
            },
          ],
        },
        "/workspace/project",
      ),
    ).toMatchObject({
      items: [
        {
          key: "format",
          command: "pnpm format",
          trust: "trusted",
          timeoutSeconds: 30,
        },
      ],
      warnings: ["One legacy hook was ignored."],
    });
  });

  it("redacts commands for hooks that are not currently trusted", () => {
    expect(
      parseHookInventory(
        {
          data: [
            {
              cwd: "/workspace/project",
              hooks: [
                {
                  key: "changed-hook",
                  eventName: "preToolUse",
                  handlerType: "command",
                  command: "curl https://example.invalid/secret",
                  timeoutSec: 10,
                  sourcePath: "/workspace/project/.codex/hooks.json",
                  source: "project",
                  enabled: true,
                  isManaged: false,
                  trustStatus: "modified",
                },
              ],
              warnings: [],
              errors: [],
            },
          ],
        },
        "/workspace/project",
      ).items[0],
    ).toMatchObject({ trust: "modified", command: null });
  });

  it("normalizes paged MCP tools and resources", () => {
    const page = parseMcpServerPage({
      data: [
        {
          name: "docs",
          serverInfo: {
            name: "Docs",
            title: "Documentation",
            version: "1.0.0",
            description: "Project docs",
            websiteUrl: "https://example.com",
          },
          authStatus: "oAuth",
          tools: {
            search: {
              name: "search",
              description: "Search docs",
              inputSchema: { type: "object" },
            },
          },
          resources: [
            {
              uri: "docs://readme",
              name: "README",
              mimeType: "text/markdown",
            },
          ],
          resourceTemplates: [
            { uriTemplate: "docs://{path}", name: "Document" },
          ],
        },
      ],
      nextCursor: "page-2",
    });
    expect(page).toMatchObject({
      nextCursor: "page-2",
      servers: [
        {
          name: "docs",
          authStatus: "oAuth",
          tools: [{ name: "search" }],
          resources: [{ uri: "docs://readme" }],
        },
      ],
    });
  });

  it("retains the managed Cantrip server and its mixed tool catalog", () => {
    const page = parseMcpServerPage({
      data: [
        {
          name: "cantrip",
          serverInfo: { name: "Cantrip", version: "1.0.0" },
          authStatus: "unsupported",
          tools: {
            context_get: { name: "context_get", inputSchema: {} },
            worktree_create: { name: "worktree_create", inputSchema: {} },
            client_notify: { name: "client_notify", inputSchema: {} },
          },
        },
      ],
    });

    expect(page.servers).toEqual([
      expect.objectContaining({
        name: "cantrip",
        tools: [
          expect.objectContaining({ name: "context_get" }),
          expect.objectContaining({ name: "worktree_create" }),
          expect.objectContaining({ name: "client_notify" }),
        ],
      }),
    ]);
  });

  it("previews only project-scoped external artifacts with opaque ids", () => {
    const preview = parseExternalImportPreview(
      {
        items: [
          {
            itemType: "COMMANDS",
            description: "Claude commands",
            cwd: "/workspace/project",
            details: {
              plugins: [],
              skills: [],
              sessions: [],
              mcpServers: [],
              hooks: [],
              subagents: [],
              commands: [{ name: "release" }],
              memory: ["/workspace/project/.claude/memory.md"],
            },
          },
          {
            itemType: "CONFIG",
            description: "Home config",
            cwd: null,
            details: null,
          },
          {
            itemType: "CONFIG",
            description: "Different project",
            cwd: "/workspace/other",
            details: null,
          },
        ],
      },
      "/workspace/project",
    );
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{24}$/u),
      itemType: "COMMANDS",
      details: {
        commandNames: ["release"],
        memoryFiles: ["memory.md"],
      },
    });
  });

  it("re-detects opaque external selections and blocks plugin imports", () => {
    const response = {
      items: [
        {
          itemType: "COMMANDS",
          description: "Claude commands",
          cwd: "/workspace/project",
          details: {
            plugins: [],
            skills: [],
            sessions: [],
            mcpServers: [],
            hooks: [],
            subagents: [],
            commands: [{ name: "release" }],
            memory: [],
          },
        },
        {
          itemType: "PLUGINS",
          description: "Claude plugins",
          cwd: "/workspace/project",
          details: {
            plugins: [
              { marketplaceName: "official", pluginNames: ["example"] },
            ],
            skills: [],
            sessions: [],
            mcpServers: [],
            hooks: [],
            subagents: [],
            commands: [],
            memory: [],
          },
        },
      ],
    };
    const preview = parseExternalImportPreview(response, "/workspace/project");
    expect(
      selectExternalImportItems(response, "/workspace/project", [
        preview.items[0]!.id,
      ]),
    ).toEqual([response.items[0]]);
    expect(() =>
      selectExternalImportItems(response, "/workspace/project", ["stale"]),
    ).toThrow(/preview again/u);
    expect(() =>
      selectExternalImportItems(response, "/workspace/project", [
        preview.items[1]!.id,
      ]),
    ).toThrow(/Plugin imports are disabled/u);
  });

  it("normalizes OAuth and asynchronous import completion without paths", () => {
    expect(
      parseMcpOauthStart(
        { authorizationUrl: "https://auth.example.test/authorize" },
        "docs",
      ),
    ).toMatchObject({ server: "docs", status: "pending" });
    expect(() =>
      parseMcpOauthStart({ authorizationUrl: "file:///tmp/token" }, "docs"),
    ).toThrow(/unsupported/u);
    expect(() =>
      parseMcpOauthStart(
        { authorizationUrl: "http://auth.example.test/authorize" },
        "docs",
      ),
    ).toThrow(/unsupported/u);
    expect(
      parseMcpOauthCompletion({
        name: "docs",
        success: false,
        error: "Denied",
      }),
    ).toEqual({
      server: "docs",
      status: "failed",
      error:
        "MCP authorization failed. Review the authorization page and try again.",
    });

    const status = parseExternalImportStatus(
      {
        importId: "import-1",
        itemTypeResults: [
          {
            itemType: "COMMANDS",
            successes: [
              {
                cwd: "/workspace/project",
                source: "/workspace/project/.claude/commands/release.md",
                target: "/isolated/codex-home/skills/release/SKILL.md",
              },
            ],
            failures: [
              {
                failureStage: "write",
                message:
                  "Could not convert /workspace/project/.claude/commands/broken.md.",
                cwd: "/workspace/project",
                source: "/workspace/project/.claude/commands/broken.md",
              },
            ],
          },
        ],
      },
      "completed",
    );
    expect(status).toEqual({
      importId: "import-1",
      status: "completed",
      results: [
        {
          itemType: "COMMANDS",
          successCount: 1,
          failures: [
            {
              failureStage: "write",
              message: "Codex reported an import failure.",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("/workspace");
    expect(JSON.stringify(status)).not.toContain("codex-home");
  });

  it("validates the combined response and limits MCP resource payloads", () => {
    expect(
      customizationInventory({
        report,
        cwd: "/workspace/project",
        skillsResponse: { data: [] },
        skillRoots: ["/workspace/project/shared-skills"],
        hooksResponse: { data: [] },
        mcpServers: [],
      }),
    ).toMatchObject({
      capabilities: { isolatedCodexHome: true },
      skillRoots: ["/workspace/project/shared-skills"],
    });
    expect(
      parseMcpResourceRead({
        contents: [
          {
            uri: "docs://readme",
            mimeType: "text/markdown",
            text: "# Project",
          },
        ],
      }),
    ).toEqual({
      contents: [
        {
          type: "text",
          uri: "docs://readme",
          mimeType: "text/markdown",
          text: "# Project",
        },
      ],
    });
    expect(() =>
      parseMcpResourceRead({
        contents: [{ uri: "blob://large", blob: "x".repeat(5_000_001) }],
      }),
    ).toThrow(/5 MB transport limit/u);
  });
});
