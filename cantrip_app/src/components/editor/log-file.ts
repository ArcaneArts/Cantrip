export function isLogFile(path: string): boolean {
  return /\.log(?:\.\d+)?$/iu.test(path.split(/[\\/]/u).at(-1) ?? "");
}
