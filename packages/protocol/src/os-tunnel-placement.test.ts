import { describe, expect, it } from "vitest";
import {
  tunnelUserCreateSchema,
  tunnelUserWireCreateSchema,
} from "./tunnels.js";
import {
  tunnelContentRecordSchema,
  tunnelPublicDestinationEndpoint,
} from "./tunnel-content.js";

const randomUUID = () => crypto.randomUUID();

const id = randomUUID();
const source = {
  bindingId: randomUUID(),
  worktreeId: randomUUID(),
  bindingGeneration: randomUUID(),
  attachmentGeneration: randomUUID(),
  runtimeGeneration: randomUUID(),
};
const destination = {
  kind: "worker-os-tcp" as const,
  workerId: "worker",
  port: 3_000,
  source,
};
const wire = {
  id,
  projectId: "project",
  protocolHint: "http",
  destination: tunnelPublicDestinationEndpoint(destination, id),
  osSource: source,
  protectedRecord: {
    operationId: id,
    revision: 1,
    protectedContent: {
      formatVersion: 1,
      domain: "tunnel-content",
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  },
};

describe("captured OS tunnel destinations", () => {
  it("keeps the private guest port separate from the public canonical source", () => {
    expect(
      tunnelUserCreateSchema.parse({
        name: "Guest HTTP",
        projectId: "project",
        protocolHint: "http",
        destination,
      }).destination,
    ).toEqual(destination);
    const parsed = tunnelUserWireCreateSchema.parse(wire);
    expect(parsed.destination).toEqual({
      kind: "worker-adapter",
      workerId: "worker",
      adapter: "cantrip-os",
      resourceId: id,
    });
    expect(JSON.stringify(parsed)).not.toContain('"port"');
    expect(parsed.osSource).toEqual(source);
  });

  it("rejects incomplete, mixed Host/guest and differently bound public captures", () => {
    for (const value of [
      { ...wire, projectId: null },
      { ...wire, osSource: undefined },
      {
        ...wire,
        destination: { ...wire.destination, resourceId: randomUUID() },
      },
      { ...wire, destination: { kind: "worker-tcp", workerId: "worker" } },
      { ...wire, osSource: { ...source, runtimeGeneration: undefined } },
      { ...wire, osSource: { ...source, desktopGeneration: "a".repeat(64) } },
      {
        ...wire,
        osSource: {
          ...source,
          transport: { kind: "docker", container: "private" },
        },
      },
    ])
      expect(tunnelUserWireCreateSchema.safeParse(value).success).toBe(false);
  });

  it("rejects caller-supplied guest transports inside encrypted TCP configuration", () => {
    const content = {
      name: "Guest",
      description: null,
      source: { kind: "desktop-loopback" },
      destination,
      dataProtection: {
        formatVersion: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        key: "k".repeat(43),
      },
    };
    expect(tunnelContentRecordSchema.safeParse(content).success).toBe(true);
    expect(
      tunnelContentRecordSchema.safeParse({
        ...content,
        destination: {
          ...destination,
          transport: { kind: "docker", container: "another-guest" },
        },
      }).success,
    ).toBe(false);
    expect(() => tunnelPublicDestinationEndpoint(destination)).toThrow(
      /canonical tunnel ID/,
    );
  });
});

it("keeps an SSH public key encrypted and excludes private keys and key options", () => {
  const publicKey =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
  const ssh = {
    kind: "worker-os-ssh" as const,
    workerId: "worker",
    source,
    publicKey,
  };
  const input = {
    name: "Workspace SSH",
    projectId: "project",
    protocolHint: "tcp",
    destination: ssh,
  };
  expect(tunnelUserCreateSchema.parse(input).destination).toEqual(ssh);
  expect(tunnelPublicDestinationEndpoint(ssh, id)).toEqual(wire.destination);
  expect(
    JSON.stringify(tunnelPublicDestinationEndpoint(ssh, id)),
  ).not.toContain(publicKey);
  for (const key of [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    `command=bad ${publicKey}`,
    `${publicKey}\n${publicKey}`,
  ])
    expect(
      tunnelUserCreateSchema.safeParse({
        ...input,
        destination: { ...ssh, publicKey: key },
      }).success,
    ).toBe(false);
  expect(
    tunnelUserCreateSchema.safeParse({
      ...input,
      destination: { ...ssh, port: 22 },
    }).success,
  ).toBe(false);
});

it("binds VNC to the canonical workspace rather than a supplied host, port or display", () => {
  const vnc = { kind: "worker-os-vnc" as const, workerId: "worker", source };
  const input = {
    name: "Assigned desktop",
    projectId: "project",
    protocolHint: "tcp",
    destination: vnc,
  };
  expect(tunnelUserCreateSchema.parse(input).destination).toEqual(vnc);
  expect(tunnelPublicDestinationEndpoint(vnc, id)).toEqual(wire.destination);
  for (const override of [
    { port: 5900 },
    { host: "127.0.0.1" },
    { display: 0 },
    { desktopGeneration: "a".repeat(64) },
  ])
    expect(
      tunnelUserCreateSchema.safeParse({
        ...input,
        destination: { ...vnc, ...override },
      }).success,
    ).toBe(false);
});

it("captures a private guest listener and restricts its public route to that same Worker Host", () => {
  const listener = {
    kind: "worker-os-listener" as const,
    workerId: "worker",
    source,
    port: 51566,
  };
  const host = {
    kind: "worker-tcp" as const,
    workerId: "worker",
    host: "127.0.0.1" as const,
    port: 51458,
  };
  const content = {
    name: "Guest to Host",
    description: null,
    source: listener,
    destination: host,
    dataProtection: {
      formatVersion: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      key: "k".repeat(43),
    },
  };
  expect(tunnelContentRecordSchema.safeParse(content).success).toBe(true);
  expect(
    tunnelContentRecordSchema.safeParse({
      ...content,
      destination: { ...host, workerId: "other" },
    }).success,
  ).toBe(false);
  const reverse = {
    ...wire,
    source: { kind: "worker-listener", workerId: "worker" },
    destination: { kind: "worker-tcp", workerId: "worker" },
  };
  expect(tunnelUserWireCreateSchema.safeParse(reverse).success).toBe(true);
  for (const invalid of [
    { ...reverse, osSource: undefined },
    { ...reverse, projectId: null },
    { ...reverse, source: { kind: "worker-listener", workerId: "other" } },
    { ...reverse, destination: wire.destination },
  ])
    expect(tunnelUserWireCreateSchema.safeParse(invalid).success).toBe(false);
});
