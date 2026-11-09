import { StringDecoder } from "node:string_decoder";

// JSON permits literal U+2028/U+2029 inside strings. Text readline treats those
// as line endings on current Node, while this protocol uses the LF byte only.
export async function* jsonLines(input) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of input) {
    pending += decoder.write(chunk);
    let at;
    while ((at = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      yield line;
    }
  }
  pending += decoder.end();
  if (pending) yield pending;
}
