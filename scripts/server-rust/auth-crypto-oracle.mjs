// Test-only reference operations; the Rust service never invokes this process.
import {
  AuthRateLimiter,
  UserSessionService,
  hashPassword,
  verifyPassword,
  hashSecret,
  normalizeAccountEmail,
  safeSecretMatch,
} from "../../cantrip_server/src/auth/service.ts";
import {
  accountRegistrationSchema,
  authLoginSchema,
  authReauthenticationSchema,
  mobileSignInGrantExchangeSchema,
} from "../../packages/protocol/dist/index.js";

process.stdin.setEncoding("utf8");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const outputs = [];
for (const request of JSON.parse(input)) {
  switch (request.operation) {
    case "validate": {
      const schema = {
        register: accountRegistrationSchema,
        login: authLoginSchema,
        reauthenticate: authReauthenticationSchema,
        exchange: mobileSignInGrantExchangeSchema,
      }[request.kind];
      const result = schema.safeParse(request.body);
      outputs.push(
        result.success
          ? { ok: result.data }
          : { error: "Invalid request body", issues: result.error.issues },
      );
      break;
    }
    case "hash":
      outputs.push(await hashPassword(request.password));
      break;
    case "verify":
      outputs.push(await verifyPassword(request.hash, request.password));
      break;
    case "secret":
      outputs.push({
        hash: hashSecret(request.value),
        email: normalizeAccountEmail(request.value),
        match: safeSecretMatch(request.value, request.expected),
      });
      break;
    case "rate": {
      const limiter = new AuthRateLimiter(request.limit);
      outputs.push(
        request.attempts.map(({ key, now }) => limiter.consume(key, now)),
      );
      break;
    }
    case "cookie": {
      const queried = [];
      const service = new UserSessionService(
        {
          getActiveUserSession: async (hash) => {
            queried.push(hash);
            return null;
          },
        },
        request.config,
      );
      const serialized = [
        service.serializeCookie(
          service.cookieName,
          request.value,
          request.maxAge,
        ),
      ];
      if (service.partitionedCookieName)
        serialized.push(
          service.serializeCookie(
            service.partitionedCookieName,
            request.value,
            request.maxAge,
            true,
          ),
        );
      const cleared = [];
      service.clear({ header: (_, cookies) => cleared.push(...cookies) });
      await service.resolve({ headers: { cookie: request.header } });
      outputs.push({ serialized, cleared, queried });
      break;
    }
    case "csrf": {
      const service = new UserSessionService({}, {});
      outputs.push(
        service.csrfMatches({ csrfTokenHash: request.hash }, request.candidate),
      );
      break;
    }
    default:
      throw new Error(`Unknown fixture operation ${request.operation}`);
  }
}
process.stdout.write(`${JSON.stringify(outputs)}\n`);
