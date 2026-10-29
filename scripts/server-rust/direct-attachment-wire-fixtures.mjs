import fixtures from "./worker-command-fixtures.json" with { type: "json" };
const command = fixtures.commands.find(
  (c) => c.type === "direct.capability.prepare",
).input.command;
export const directAttachmentWireFixtures = {
  projectShareDirectCreateSchema: [
    { clientId: "desktop-client" },
    { clientId: "  trimmed client  " },
    { clientId: "\ud800" },
    { clientId: "x".repeat(200) },
  ],
  directAttachmentTicketSchema: [
    {
      broker: {
        available: true,
        leaseRenewal: true,
        protocol: "ws-v1",
        loopbackHost: "127.0.0.1",
        loopbackPort: 43123,
        instanceId: "55555555-5555-4555-8555-555555555555",
        publicKey: "a".repeat(43),
        fingerprint: "b".repeat(64),
      },
      binding: command.binding,
      secret: command.secret,
    },
  ],
  directCapabilityPrepareResultSchema: [
    { accepted: true, capabilityId: command.binding.capabilityId },
  ],
  directCapabilityRenewResultSchema: [
    { renewed: true },
    { renewed: false },
    { renewed: true, leaseExpiresAt: command.binding.leaseExpiresAt },
  ],
  directTransportTelemetrySchema: [
    {
      bytesFromLocal: 0,
      bytesToLocal: 2,
      connectionsClosed: 3,
      connectionsOpened: 5,
    },
    {
      bytesFromLocal: 9007199254740991,
      bytesToLocal: 9007199254740991,
      connectionsClosed: 0,
      connectionsOpened: 0,
      lastDestinationRejectionCode: "unauthorized",
    },
  ],
};
directAttachmentWireFixtures.directTunnelTicketSchema = [
  {
    ...directAttachmentWireFixtures.directAttachmentTicketSchema[0],
    route: {
      tunnelId: "terminal:fixture-terminal",
      attachmentId: command.binding.attachmentId,
      sourceEndpointId: "desktop:fixture-client:fixture-attachment",
      destinationEndpointId: "worker:fixture-worker",
    },
  },
];
