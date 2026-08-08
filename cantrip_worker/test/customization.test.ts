import { describe, expect, it } from "vitest";

import { codexRuntimeReportSchema } from "@cantrip/protocol";

import {
  customizationCapabilities,
  customizationInventory,
  parseExternalImportPreview,
  parseHookInventory,
  parseMcpResourceRead,
  parseMcpServerPage,
  parseSkillInventory,
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
  version: { raw: "codex-cli 0.146.1", semantic: "0.146.1" },
  testedRange: ">=0.146.0 <0.147.0",
  initialize: {
    userAgent: "codex_cli_rs/0.146.1",
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
  degradedReasons: [],
});

describe("Codex customization inventory", () => {
  it("separates native method support from production stability policy", () => {
    const capabilities = customizationCapabilities(report);
    expect(capabilities).toMatchObject({
      isolatedCodexHome: true,
      nativeSubagents: { available: true },
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
    expect(capabilities.plugins.list.reason).toContain("under development");

    const partial = customizationCapabilities({
      ...report,
      methods: { ...report.methods, "skills/config/write": "unavailable" },
    });
    expect(partial.skills.list.available).toBe(true);
    expect(partial.skills.configure.available).toBe(false);
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

  it("validates the combined response and limits MCP resource payloads", () => {
    expect(
      customizationInventory({
        report,
        cwd: "/workspace/project",
        skillsResponse: { data: [] },
        hooksResponse: { data: [] },
        mcpServers: [],
      }),
    ).toMatchObject({ capabilities: { isolatedCodexHome: true } });
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
