// Execute the existing Node implementations; do not restate their algorithms.
import { nativeHistoryItemKey } from "../../tests/reference-node-server/src/db/repository/native-history-items.ts";
import { protectedEventId } from "../../tests/reference-node-server/src/db/repository/native-history-output-alias.ts";

const cases = [];
for (const chat of ["chat", "雪😀", "chat\0suffix"])
  for (const key of ["root:turn:item", "", "item\0😀"])
    for (const component of ["assistant", "activity"]) {
      const identity = {
        threadId: "thread",
        turnId: "turn",
        itemId: key,
        component,
        identityKind: "canonical",
      };
      cases.push({
        chat,
        key,
        identity,
        eventId: protectedEventId(chat, key),
        itemKey: nativeHistoryItemKey(chat, identity),
      });
    }
console.log(JSON.stringify(cases));
