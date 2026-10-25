/** Synthetic history only; rendered controls and all file operations stay real.
 * Installed by the disposable repository fixture, never by production Vite. */
export function transformChatHistoryFixture(source, id) {
  if (!id.replaceAll("\\", "/").endsWith("/cantrip_app/src/lib/api/chats.ts"))
    return null;
  const marker = "  const readIdentity = getClientSessionIdentitySnapshot();";
  if (source.split(marker).length !== 2)
    throw new Error(
      "QA history injection no longer uniquely matches getMessagePage",
    );
  return {
    code: source.replace(
      marker,
      `
  const qaHistory = JSON.parse(sessionStorage.getItem('__qaChatFileHistory') ?? 'null');
  if (qaHistory?.chatId === chatId) {
    const { chatMessageSchema } = await import('@cantrip/protocol');
    return {
      messages: [chatMessageSchema.parse({
        id: qaHistory.messageId, chatId, worktreeId: qaHistory.worktreeId,
        executionLaneId: null, role: 'assistant', sequence: 1,
        modelId: null, modelRouteId: null, providerId: null,
        providerName: null, providerModelName: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        content: [{type:'text', text: qaHistory.text}],
      })],
      page: {hasMore:false, nextBeforeSequence:null, oldestSequence:1, newestSequence:1, startsAtUserTurn:false},
      nativeTurnSettings: [],
    };
  }
${marker}`,
    ),
    map: null,
  };
}
