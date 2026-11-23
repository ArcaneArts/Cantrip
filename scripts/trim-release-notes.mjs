import { readFile, writeFile } from "node:fs/promises";

const githubBodyLimit = 125_000;
const notesFile = process.argv[2];
const notes = await readFile(notesFile);

if (notes.length > githubBodyLimit) {
  const changelog = notes
    .toString("utf8")
    .match(
      /^\*\*Full Changelog\*\*: https:\/\/github\.com\/\S{1,2048}$/mu,
    )?.[0];
  const footer = Buffer.from(
    "\n\n_Release notes shortened to fit GitHub's length limit._\n" +
      (changelog ? `\n${changelog}\n` : ""),
  );
  const excerpt = notes.subarray(0, githubBodyLimit - footer.length);
  const lastLine = excerpt.lastIndexOf(0x0a);
  await writeFile(
    notesFile,
    Buffer.concat([excerpt.subarray(0, Math.max(0, lastLine)), footer]),
  );
}
