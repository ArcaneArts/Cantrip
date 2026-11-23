// Authenticate through the actual production HTTP entrypoint. Keep the same
// cookie throughout the outage so recovery cannot conceal a lost session.
import assert from "node:assert/strict";

export async function logRuntimeAuth(origin, profile, password) {
  const cookies = new Map();
  async function request(route, options = {}) {
    const response = await fetch(origin + route, {
      ...options,
      headers: {
        origin: "http://127.0.0.1:5173",
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...options.headers,
      },
      signal: AbortSignal.timeout(10000),
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0],
        separator = pair.indexOf("=");
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return { status: response.status, body: await response.json() };
  }
  const initial = await request("/api/auth/session");
  assert.equal(initial.status, 200);
  if (profile !== "none") {
    const registration = profile === "accounts";
    const result = await request(
      registration ? "/api/auth/register" : "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          registration
            ? {
                email: "database-outage@example.invalid",
                displayName: "Database outage",
                password,
              }
            : { password },
        ),
      },
    );
    assert.equal(result.status, registration ? 201 : 200);
  }
  const session = await request("/api/auth/session");
  assert.equal(session.status, 200);
  if (profile === "none") {
    assert.equal(session.body.currentUser, null);
    assert.equal(session.body.csrfToken, null);
  } else {
    assert.equal(typeof session.body.currentUser?.id, "string");
    assert.equal(typeof session.body.csrfToken, "string");
    assert.ok(cookies.size);
  }
  return {
    cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    evidence: {
      profile,
      currentUser: session.body.currentUser,
      hasCsrfToken: typeof session.body.csrfToken === "string",
      expiresAt: session.body.expiresAt,
    },
  };
}
