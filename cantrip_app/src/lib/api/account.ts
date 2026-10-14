import {
  systemHealthSchema,
  serverBootstrapSchema,
  authSessionStateSchema,
  accountSessionListSchema,
  accountResourceUsageSchema,
  accountResourceUsageHistoryQuerySchema,
  accountResourceUsageHistorySchema,
  accountLiveTrafficQuerySchema,
  accountLiveTrafficSchema,
  authSessionSchema,
  authLoginSchema,
  mobileSignInGrantCreateResultSchema,
  mobileSignInGrantExchangeSchema,
  accountRegistrationSchema,
  accountAdminSummarySchema,
  accountLicenseWhitelistEntrySchema,
  accountLicenseWhitelistCreateSchema,
  authLogoutAllResultSchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import type {
  AccountResourceUsageHistoryQuery,
  AccountLiveTrafficQuery,
  AuthLogin,
  MobileSignInGrantExchange,
  AccountRegistration,
} from "@cantrip/protocol";

export async function getSystemHealth() {
  return systemHealthSchema.parse(await request("/api/health"));
}

export async function getServerBootstrap() {
  return serverBootstrapSchema.parse(
    await request("/api/bootstrap", {
      signal: AbortSignal.timeout(10_000),
    }),
  );
}

export async function getAuthSession() {
  return authSessionStateSchema.parse(
    await request("/api/auth/session", {
      signal: AbortSignal.timeout(10_000),
    }),
  );
}

export async function getAccountSessions() {
  return accountSessionListSchema.parse(await request("/api/account/sessions"));
}

export async function getAccountResourceUsage() {
  return accountResourceUsageSchema.parse(
    await request("/api/account/resource-usage"),
  );
}

export async function getAccountResourceUsageHistory(
  input: AccountResourceUsageHistoryQuery,
) {
  const query = accountResourceUsageHistoryQuerySchema.parse(input);
  return accountResourceUsageHistorySchema.parse(
    await request(
      `/api/account/resource-usage/history?${new URLSearchParams(query).toString()}`,
    ),
  );
}

export async function getAccountLiveTraffic(
  input: AccountLiveTrafficQuery = {},
  signal?: AbortSignal,
) {
  const query = accountLiveTrafficQuerySchema.parse(input);
  const suffix = new URLSearchParams(query).toString();
  return accountLiveTrafficSchema.parse(
    await request(`/api/account/live-traffic${suffix ? `?${suffix}` : ""}`, {
      signal,
    }),
  );
}

export async function login(input: AuthLogin) {
  return authSessionSchema.parse(
    await post("/api/auth/login", authLoginSchema.parse(input)),
  );
}

export async function createMobileSignInGrant() {
  return mobileSignInGrantCreateResultSchema.parse(
    await post("/api/auth/mobile-sign-in/grants", {}),
  );
}

export async function exchangeMobileSignInGrant(
  serverUrl: string,
  input: MobileSignInGrantExchange,
) {
  return authSessionSchema.parse(
    await request(`${serverUrl}/api/auth/mobile-sign-in/exchange`, {
      method: "POST",
      body: JSON.stringify(mobileSignInGrantExchangeSchema.parse(input)),
    }),
  );
}

export async function registerAccount(
  input: AccountRegistration,
  bootstrapToken?: string,
) {
  return authSessionSchema.parse(
    await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(accountRegistrationSchema.parse(input)),
      headers: bootstrapToken
        ? { "x-cantrip-bootstrap-token": bootstrapToken }
        : undefined,
    }),
  );
}

export async function getAccountAdminSummary() {
  return accountAdminSummarySchema.parse(await request("/api/admin/accounts"));
}

export async function addAccountLicenseWhitelistEntry(email: string) {
  return accountLicenseWhitelistEntrySchema.parse(
    await post(
      "/api/admin/license-whitelist",
      accountLicenseWhitelistCreateSchema.parse({ email }),
    ),
  );
}

export async function removeAccountLicenseWhitelistEntry(
  entryId: string,
): Promise<void> {
  await request(`/api/admin/license-whitelist/${encodeURIComponent(entryId)}`, {
    method: "DELETE",
  });
}

export async function logout(): Promise<void> {
  await post("/api/auth/logout", {});
}

export async function logoutAll() {
  return authLogoutAllResultSchema.parse(
    await post("/api/auth/logout-all", {}),
  );
}
