import { spawn } from "node:child_process";
import { remoteCursorSpriteSchema } from "@cantrip/protocol";
import { resolveCuaBinary } from "../computer-use/binary.js";

/** Pure rasterization mode: no native backend, permissions, or CUA session. */
export function browserCursorSprite(identity: string) {
  return new Promise<ReturnType<typeof remoteCursorSpriteSchema.parse>>(
    (resolve, reject) => {
      const child = spawn(resolveCuaBinary(), ["--cursor-sprite"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let output = "";
      const timeout = setTimeout(() => child.kill(), 5000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 2_000_000) child.kill();
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        try {
          if (code !== 0) throw new Error("Cursor rasterization failed.");
          resolve(remoteCursorSpriteSchema.parse(JSON.parse(output)));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(identity);
    },
  );
}
