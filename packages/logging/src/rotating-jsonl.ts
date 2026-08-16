import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { sanitizeLogRecordInput, type ServiceLogRecord } from "./records.js";

export type RotatingJsonlLogOptions = {
  filePath: string;
  maxBytes?: number;
  maxFiles?: number;
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Rotating log limits must be positive safe integers.");
  }
  return value;
}

export class RotatingJsonlLog {
  readonly #filePath: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  #descriptor: number | null = null;
  #bytes = 0;

  constructor(options: RotatingJsonlLogOptions) {
    this.#filePath = options.filePath;
    this.#maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.#maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
    mkdirSync(dirname(this.#filePath), { recursive: true });
    this.#descriptor = openSync(this.#filePath, "a");
    this.#bytes = statSync(this.#filePath).size;
  }

  close(): void {
    if (this.#descriptor === null) return;
    closeSync(this.#descriptor);
    this.#descriptor = null;
  }

  write(record: ServiceLogRecord): void {
    const sanitized = {
      ...sanitizeLogRecordInput(record),
      cursor: record.cursor,
    };
    const line = `${JSON.stringify(sanitized)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.#bytes > 0 && this.#bytes + bytes > this.#maxBytes) {
      this.#rotate();
    }
    if (this.#descriptor === null) {
      this.#descriptor = openSync(this.#filePath, "a");
    }
    writeSync(this.#descriptor, line);
    this.#bytes += bytes;
  }

  #rotate(): void {
    this.close();
    const oldest = `${this.#filePath}.${this.#maxFiles}`;
    if (existsSync(oldest)) rmSync(oldest);
    for (let index = this.#maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.#filePath}.${index}`;
      if (existsSync(source))
        renameSync(source, `${this.#filePath}.${index + 1}`);
    }
    if (existsSync(this.#filePath)) {
      renameSync(this.#filePath, `${this.#filePath}.1`);
    }
    this.#descriptor = openSync(this.#filePath, "a");
    this.#bytes = 0;
  }
}
