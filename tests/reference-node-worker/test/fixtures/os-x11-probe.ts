import { spawn } from "node:child_process";
import {
  remoteCommand,
  type OsExecutorTransport,
} from "../../src/os-executor/connection.js";

/** Disposable guest acceptance only: independently query actual X11 physical state. */
export function probeX11(
  transport: OsExecutorTransport,
  display: number,
  held?: boolean,
): Promise<{ mask: number; x: number; y: number; shift: boolean }> {
  if (!Number.isSafeInteger(display) || display < 0)
    throw new Error("Invalid fixture display.");
  const command = remoteCommand(transport, []);
  if (transport.kind === "docker")
    command.args.splice(-1, 1, "/usr/bin/python3", "-");
  else command.args[command.args.length - 1] = "sudo -n -- /usr/bin/python3 -";
  const script = `import ctypes,json,time
l=ctypes.CDLL('libX11.so.6')
l.XOpenDisplay.restype=ctypes.c_void_p
l.XOpenDisplay.argtypes=[ctypes.c_char_p]
l.XDefaultRootWindow.restype=ctypes.c_ulong
l.XDefaultRootWindow.argtypes=[ctypes.c_void_p]
l.XQueryPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong]+[ctypes.c_void_p]*7
l.XCloseDisplay.argtypes=[ctypes.c_void_p]
l.XQueryKeymap.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
l.XKeysymToKeycode.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
l.XKeysymToKeycode.restype=ctypes.c_ubyte
d=l.XOpenDisplay(b':${display}')
assert d
r=l.XDefaultRootWindow(d)
expected=${held === undefined ? "None" : held ? "True" : "False"}
deadline=time.monotonic()+20
try:
 while True:
  windows=[ctypes.c_ulong(),ctypes.c_ulong()]
  points=[ctypes.c_int() for _ in range(4)]
  mask=ctypes.c_uint()
  assert l.XQueryPointer(d,r,*[ctypes.byref(v) for v in windows+points],ctypes.byref(mask))
  keys=ctypes.create_string_buffer(32); l.XQueryKeymap(d,keys)
  key=l.XKeysymToKeycode(d,65505)
  result={'mask':mask.value,'x':points[0].value,'y':points[1].value,'shift':bool(keys.raw[key//8]&(1<<(key%8)))}
  if expected is None or bool(mask.value&256)==expected or time.monotonic()>=deadline: break
  time.sleep(.02)
 print(json.dumps(result))
finally: l.XCloseDisplay(d)
`;
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Guest X11 probe timed out."));
    }, 45_000);
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      errors = (errors + data).slice(-1024);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(`Guest X11 probe exited ${code}: ${errors}`));
      else {
        try {
          resolve(JSON.parse(output));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(script);
  });
}
