// Reuse the actual browser's authenticated session for host-side test controls.
// These development routes do not participate in the app's CORS router.
export async function browserFixtureSql(
  fixture,
  page,
  statements,
  queries = [],
) {
  const cookies = await page.context().cookies(fixture.server.origin);
  const client = fixture.client();
  client.cookies = new Map(cookies.map(({ name, value }) => [name, value]));
  client.csrf = await page.evaluate(async () => {
    const { getClientSession } = await import("/src/lib/client-session.ts");
    return getClientSession()?.csrfToken;
  });
  return fixture.sql(statements, queries);
}
