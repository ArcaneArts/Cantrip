import { spawn } from "node:child_process";
import {
  remoteCommand,
  type OsExecutorTransport,
} from "../../src/os-executor/connection.js";

/** A disposable real guest server. stdin EOF ends its complete process lifetime. */
export async function guestTcpServer(transport: OsExecutorTransport) {
  const script = `import hashlib,json,socket,sys,threading
s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(8)
print(json.dumps({'port':s.getsockname()[1]}),flush=True)
def reply(c):
 with c:
  b=bytearray()
  while True:
   part=c.recv(65536)
   if not part: break
   b.extend(part)
  c.sendall(b[::-1]+hashlib.sha256(b).digest())
def accept():
 while True:
  try: c,_=s.accept()
  except OSError: return
  threading.Thread(target=reply,args=(c,),daemon=True).start()
threading.Thread(target=accept,daemon=True).start()
sys.stdin.buffer.read()
s.close()
`;
  const command = remoteCommand(transport, []);
  if (transport.kind === "docker")
    command.args.splice(-1, 1, "/usr/bin/python3", "-u", "-c", script);
  else
    command.args[command.args.length - 1] =
      `sudo -n -- /usr/bin/python3 -u -c '${script.replaceAll("'", "'\\''")}'`;
  const child = spawn(command.command, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Guest TCP fixture exited unsuccessfully.")),
    );
  });
  child.stderr.resume();
  const port = await new Promise<number>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      child.stdin.end();
      reject(new Error("Guest TCP fixture did not bind."));
    }, 20_000);
    child.stdout.on("data", (data) => {
      text += data;
      if (text.includes("\n")) {
        clearTimeout(timer);
        resolve(
          (JSON.parse(text.slice(0, text.indexOf("\n"))) as { port: number })
            .port,
        );
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Guest TCP fixture exited before binding."));
    });
  });
  return {
    port,
    close: async () => {
      child.stdin.end();
      await closed;
    },
  };
}
