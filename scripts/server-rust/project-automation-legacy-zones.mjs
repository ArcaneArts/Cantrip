// Preserve ICU's legacy SystemV aliases, including historical exceptions that
// differ from modern America/* zones. Development-only extraction from the
// actual Source Intl implementation; the server reads the resulting TZif data.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const destination = new URL(
  "../../cantrip_server_rs/src/project_automations/zones/",
  import.meta.url,
);
const day = 86400000;
const start = Date.parse("0001-01-01T12:00:00Z"),
  end = Date.parse("2101-01-01T12:00:00Z");
function header(count, size) {
  const b = Buffer.alloc(44);
  b.write("TZif2");
  [0, 0, 0, count, 2, size].forEach((n, i) => b.writeUInt32BE(n, 20 + i * 4));
  return b;
}
function block(transitions, width, standard) {
  const abbreviations = Buffer.from("STD\0DST\0");
  const table = Buffer.alloc(transitions.length * (width + 1) + 12);
  for (const [i, t] of transitions.entries()) {
    if (width === 8) table.writeBigInt64BE(BigInt(t.at), i * width);
    else table.writeInt32BE(t.at, i * width);
    table[transitions.length * width + i] = t.type;
  }
  const at = transitions.length * (width + 1);
  table.writeInt32BE(standard, at);
  table[at + 4] = 0;
  table[at + 5] = 0;
  table.writeInt32BE(standard + 3600, at + 6);
  table[at + 10] = 1;
  table[at + 11] = 4;
  return Buffer.concat([
    header(transitions.length, abbreviations.length),
    table,
    abbreviations,
  ]);
}
const results = [];
await mkdir(destination, { recursive: true });
for (const [suffix, west] of [
  ["AST4ADT", 4],
  ["CST6CDT", 6],
  ["EST5EDT", 5],
  ["MST7MDT", 7],
  ["PST8PDT", 8],
  ["YST9YDT", 9],
]) {
  const name = "SystemV/" + suffix,
    standard = -west * 3600;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: name,
    timeZoneName: "longOffset",
    hour: "numeric",
  });
  const offset = (milliseconds) => {
    const zone = formatter
      .formatToParts(new Date(milliseconds))
      .find((p) => p.type === "timeZoneName").value;
    const m = /^GMT([+-])(\d\d):(\d\d)$/.exec(zone);
    assert(m, zone);
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
  };
  assert.equal(offset(start), standard);
  const transitions = [];
  let previous = standard;
  for (let at = start + day; at < end; at += day) {
    const current = offset(at);
    if (current === previous) continue;
    assert([standard, standard + 3600].includes(current));
    let lower = Math.floor((at - day) / 1000),
      upper = Math.floor(at / 1000);
    while (upper - lower > 1) {
      const middle = Math.floor((lower + upper) / 2);
      if (offset(middle * 1000) === previous) lower = middle;
      else upper = middle;
    }
    transitions.push({ at: upper, type: current === standard ? 0 : 1 });
    previous = current;
  }
  // Check the footer's transition second against Source for a complete future
  // Gregorian cycle rather than substituting modern US daylight-saving rules.
  for (let year = 2101; year <= 2500; year++) {
    const lastSunday = (month) => {
      const last = new Date(Date.UTC(year, month + 1, 0));
      return last.getUTCDate() - last.getUTCDay();
    };
    const spring = Date.UTC(year, 3, lastSunday(3), 2 + west);
    const autumn = Date.UTC(year, 9, lastSunday(9), 1 + west);
    assert.equal(offset(spring - 1000), standard);
    assert.equal(offset(spring), standard + 3600);
    assert.equal(offset(autumn - 1000), standard + 3600);
    assert.equal(offset(autumn), standard);
  }
  const footer = Buffer.from(`\nSTD${west}DST,M4.5.0/2,M10.5.0/2\n`);
  const bytes = Buffer.concat([
    block(
      transitions.filter((t) => t.at >= -2147483648 && t.at <= 2147483647),
      4,
      standard,
    ),
    block(transitions, 8, standard),
    footer,
  ]);
  const file = new URL(suffix.toLowerCase() + ".tzif", destination);
  if (process.argv.includes("--write")) await writeFile(file, bytes);
  else
    assert.deepEqual(
      await readFile(file),
      bytes,
      name + " must match actual Source Intl history",
    );
  results.push({
    name,
    transitions: transitions.length,
    bytes: bytes.length,
    first: transitions[0],
    last: transitions.at(-1),
  });
}
console.log(
  JSON.stringify({
    node: process.versions.node,
    icu: process.versions.icu,
    tz: process.versions.tz,
    zones: results,
  }),
);
