// Shared raw input corpus for actual parser/socket comparisons.
import { initialize } from "./live-sockets.mjs";
const array = (depth) => "[".repeat(depth) + "0" + "]".repeat(depth);
const object = (depth) => '{"x":'.repeat(depth) + "null" + "}".repeat(depth);
const http = [];
const add = (name, raw, status = 400, options = {}) =>
  http.push({ name, raw, status, ...options });
for (const depth of [128, 2048, 20000]) {
  add(`unknown array ${depth}`, '{"extra":' + array(depth) + "}", 201);
  add(`unknown object ${depth}`, '{"extra":' + object(depth) + "}", 201);
  add(`root array ${depth}`, array(depth));
  add(`known wrong type ${depth}`, '{"label":' + array(depth) + "}");
  add(`truncated array ${depth}`, '{"extra":' + array(depth).slice(0, -1));
  add(
    `duplicate drops deep ${depth}`,
    '{"extra":' + array(depth) + ',"extra":true}',
    201,
  );
  add(
    `nested poison ${depth}`,
    '{"extra":' +
      "[".repeat(depth) +
      '{"__proto__":{}}' +
      "]".repeat(depth) +
      "}",
  );
}
for (const [name, raw] of [
  ["empty", ""],
  ["whitespace", " \t\r\n"],
  ["truncated object", '{"extra":'],
  ["trailing comma", '{"extra":1,}'],
  ["trailing token", "{} false"],
  ["leading zero", '{"extra":01}'],
  ["bad fraction", '{"extra":1.}'],
  ["bad exponent", '{"extra":1e+}'],
  ["nonfinite literal", '{"extra":NaN}'],
  ["raw control", '{"extra":"\u0000"}'],
  ["bad escape", '{"extra":"\\x00"}'],
  ["bad unicode escape", '{"extra":"\\uD80"}'],
  ["prototype key", '{"__proto__":{}}'],
  ["constructor prototype", '{"extra":{"constructor":{"prototype":{}}}}'],
])
  add(name, raw);
for (const [name, raw] of [
  ["null defaults", "null"],
  ["BOM", "\ufeff{}"],
  [
    "strings and escapes",
    '{"extra":"\\ud800\\udfff\\ud800é😀\\\\\\\"/\\b\\f\\n\\r\\t"}',
  ],
  [
    "numeric overflow",
    '{"extra":[1e999,-1e999,-0,1.7976931348623157e308,5e-324]}',
  ],
  ["duplicate and index keys", '{"9":0,"2":0,"extra":0,"2":1,"4294967295":2}'],
  [
    "constructor without prototype",
    '{"constructor":{},"extra":{"prototype":{}}}',
  ],
])
  add(name, raw, 201);
add(
  "invalid UTF8 replacement",
  Buffer.from([123, 34, 120, 34, 58, 34, 240, 128, 128, 34, 125]),
  201,
);
add("plain text", "{}", 400, { contentType: "text/plain" });
add("unsupported type", "{}", 415, { contentType: "application/xml" });

const websocket = [];
const init = JSON.stringify(initialize());
const ws = (name, raw, code = "invalid-message", extra = {}) =>
  websocket.push({ name, raw, code, ...extra });
for (const depth of [128, 2048, 20000]) {
  ws(
    `unknown array ${depth}`,
    init.slice(0, -1) + ',"extra":' + array(depth) + "}",
  );
  // Keep valid deeply nested objects below the existing 64 KiB Live limit.
  ws(
    `unknown object ${depth}`,
    init.slice(0, -1) + ',"extra":' + object(Math.min(depth, 9000)) + "}",
  );
  ws(`root array ${depth}`, array(depth));
  ws(`truncated array ${depth}`, array(depth).slice(0, -1));
  ws(
    `nested known field ${depth}`,
    init.replace('"name":"Cantrip Live fixture"', '"name":' + array(depth)),
  );
}
for (const [name, raw] of [
  ["empty", ""],
  ["whitespace", " \n"],
  ["trailing token", "{}false"],
  ["trailing comma", '{"type":"initialize",}'],
  ["BOM is not JSON", "\ufeff" + init],
  ["invalid escape", '{"type":"\\uZZZZ"}'],
  ["null", "null"],
  ["string", '"hello"'],
  ["number overflow", "1e999"],
])
  ws(name, raw);
ws("valid initialization", init, null);
ws("lone UTF16 echo", '{"type":"ping","nonce":"\\ud800\\udfff\\ud800"}', null, {
  initialized: true,
});
ws(
  "duplicate properties",
  init.replace(
    '"protocolVersion":1',
    '"protocolVersion":99,"protocolVersion":1',
  ),
  null,
);

export { array, object, http, websocket };
