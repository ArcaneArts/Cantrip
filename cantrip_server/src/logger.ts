import {
  createPinoServiceLogStream,
  createServiceLogger,
  type ServiceLogFormatterOptions,
} from "@cantrip/logging";

export const serverLogger = createServiceLogger("server");

export function createServerLogStream(options?: ServiceLogFormatterOptions): {
  write(line: string): void;
} {
  return createPinoServiceLogStream("server", options);
}
