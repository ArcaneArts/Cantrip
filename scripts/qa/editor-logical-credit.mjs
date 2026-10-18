/** Runs only in the fixture's Vite build, never the production build. */
export function createLogicalCreditProbe() {
  let armed = false;
  let selected = null;
  let identity = null;
  let currentIdentity = null;
  let creditBytes = 0;
  let receivedBytes = 0;
  let withheldCredits = 0;
  let withheldBytes = 0;
  let retired = false;
  const route = (header) => ({
    tunnelId: header.tunnelId,
    attachmentId: header.attachmentId,
    sourceEndpointId: header.sourceEndpointId,
    destinationEndpointId: header.destinationEndpointId,
    connectionId: header.connectionId,
  });
  return {
    arm() {
      if (selected !== null)
        throw new Error("The previous QA stream is still owned.");
      identity = null;
      currentIdentity = null;
      creditBytes = 0;
      receivedBytes = 0;
      withheldCredits = 0;
      withheldBytes = 0;
      retired = false;
      armed = true;
    },
    select(url, connectionId, initialCreditBytes, getIdentity) {
      if (
        !armed ||
        selected !== null ||
        !new URL(url).searchParams.has("qaBulk")
      )
        return;
      selected = connectionId;
      creditBytes = initialCreditBytes;
      currentIdentity = getIdentity;
      identity = route(getIdentity());
    },
    received(connectionId, bytes) {
      if (connectionId === selected) receivedBytes += bytes;
    },
    withhold(connectionId, bytes) {
      if (!armed || connectionId !== selected) return false;
      withheldCredits += 1;
      withheldBytes += bytes;
      return true;
    },
    retired(connectionId) {
      if (connectionId === selected) retired = true;
    },
    snapshot() {
      return {
        armed,
        selected,
        identity,
        currentIdentity: currentIdentity ? route(currentIdentity()) : null,
        creditBytes,
        receivedBytes,
        withheldCredits,
        withheldBytes,
        retired,
      };
    },
    release() {
      armed = false;
      selected = null;
      currentIdentity = null;
    },
  };
}

export function logicalCreditFixturePlugin() {
  return {
    name: "cantrip-qa-logical-credit",
    enforce: "pre",
    transform(source, id) {
      if (
        !id
          .replaceAll("\\", "/")
          .endsWith("/cantrip_app/src/lib/browser-code-tunnel.ts")
      )
        return null;
      const replace = (before, after) => {
        const position = source.indexOf(before);
        if (
          position < 0 ||
          source.indexOf(before, position + before.length) >= 0
        ) {
          throw new Error(
            "The QA logical-credit instrumentation could not bind its exact transport operation.",
          );
        }
        source = source.replace(before, after);
      };
      replace(
        "class BrowserTunnelConnection {",
        `const __qaLogicalCredit = (${createLogicalCreditProbe.toString()})();\nglobalThis.__qaLogicalCredit = __qaLogicalCredit;\nclass BrowserTunnelConnection {`,
      );
      replace(
        "  const chunks: Uint8Array[] = [];\n  let bytes = 0;\n  connection.onData",
        "  __qaLogicalCredit.select(request.url, connection.id, INITIAL_CREDIT_BYTES, () => tunnel.identities(connection.id, 0));\n  const chunks: Uint8Array[] = [];\n  let bytes = 0;\n  connection.onData",
      );
      replace(
        "      const copy = Uint8Array.from(payload);",
        "      __qaLogicalCredit.received(this.id, payload.byteLength);\n      const copy = Uint8Array.from(payload);",
      );
      replace(
        '        this.tunnel.sendControl({\n          ...this.tunnel.identities(this.id, this.#sourceSequence++),\n          kind: "credit",',
        '        if (__qaLogicalCredit.withhold(this.id, payload.byteLength)) return;\n        this.tunnel.sendControl({\n          ...this.tunnel.identities(this.id, this.#sourceSequence++),\n          kind: "credit",',
      );
      replace(
        "    this.tunnel.forgetConnection(this);",
        "    __qaLogicalCredit.retired(this.id);\n    this.tunnel.forgetConnection(this);",
      );
      return { code: source, map: null };
    },
  };
}
