import { CantripApiError } from "@/lib/api-client";

/** The terminal event can arrive after interruption is accepted. Retry the real
 * mutation, without treating a cached running badge as authority. */
export async function retryAfterChatInterruption<T>(
  mutate: () => Promise<T>,
  interrupt?: () => Promise<unknown>,
): Promise<T> {
  if (interrupt) await interrupt();
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await mutate();
    } catch (error) {
      if (
        !interrupt ||
        !(error instanceof CantripApiError) ||
        error.status !== 409 ||
        error.message !== "Stop the running chat first." ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
