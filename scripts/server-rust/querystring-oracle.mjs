// Exercise the parser actually resolved by the installed reference Fastify.
import { createRequire } from "node:module";
const server = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const fastify = createRequire(server.resolve("fastify"));
const { parse } = fastify("fast-querystring");
let count = 0;
function emit(input) {
  process.stdout.write(
    JSON.stringify({ input, output: JSON.stringify(parse(input)) }) + "\n",
  );
  count++;
}
for (const input of [
  "",
  "&",
  "&&",
  "=",
  "=x",
  "a",
  "a=",
  "a==",
  "a=b=c",
  "a=x&a=y&a=z",
  "a=one&%61=two",
  "__proto__=x&constructor=y&toString=z&pop=x",
  "2=b&1=a&0=c&4294967294=x&4294967295=y",
  "a=+%FF&%41%FF=x",
  "a=%",
  "a=%0",
  "a=%GG",
  "a=%E2%82",
  "a=%ED%A0%80",
  "a=%F4%90%80%80",
  "a=%F0%9F%A6%80",
  "a=%25FF",
  "key=raw😀&%F0%9F%A6%80=crab",
  "a=\0&\0=x",
  "a=%C3x%A9",
  "a=%C3é%A9",
])
  emit(input);
const octet = (value) => "%" + value.toString(16).padStart(2, "0");
for (let first = 0; first < 256; first++) {
  emit(`${octet(first)}=value&key=${octet(first)}`);
  for (let second = 0; second < 256; second++)
    emit(`a=${octet(first)}${octet(second)}&${octet(first)}${octet(second)}=x`);
}
const boundary = [0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xaf, 0xbf, 0xc0];
for (const lead of [0xe0, 0xe1, 0xed, 0xef, 0xf0, 0xf1, 0xf4, 0xf5])
  for (const second of boundary)
    for (const third of boundary) {
      const prefix = octet(lead) + octet(second) + octet(third);
      emit("a=" + prefix);
      for (const fourth of boundary) emit("a=" + prefix + octet(fourth));
    }
process.stdout.write(JSON.stringify({ done: count }) + "\n");
