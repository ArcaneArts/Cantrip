// Optional test diagnostics. Observe the real client's socket selection without
// changing connection ownership, request headers, retries or failure handling.
import { channel } from "node:diagnostics_channel";

export function traceHttpConnections() {
  const events = [],
    sockets = new WeakMap(),
    requests = new WeakMap();
  const listeners = [];
  let sequence = 0,
    active = true;
  const record = (value) => {
    if (active) events.push({ at: Date.now(), ...value });
  };
  const socketId = (socket) => {
    let id = sockets.get(socket);
    if (!id) {
      id = ++sequence;
      sockets.set(socket, id);
      const details = {
        socket: id,
        localPort: socket.localPort,
        remotePort: socket.remotePort,
      };
      record({ event: "socket", ...details });
      for (const event of ["end", "close", "error"]) {
        const listener = (error) =>
          record({
            event,
            ...details,
            code: error?.code,
            destroyed: socket.destroyed,
          });
        socket.on(event, listener);
        listeners.push(() => socket.off(event, listener));
      }
    }
    return id;
  };
  const sent = ({ request, socket }) => {
    const id = socketId(socket);
    requests.set(request, id);
    record({
      event: "send",
      socket: id,
      method: request.method,
      origin: String(request.origin),
      path: request.path.split("?")[0],
      destroyed: socket.destroyed,
    });
  };
  const failed = ({ request, error }) =>
    record({
      event: "request-error",
      socket: requests.get(request),
      method: request.method,
      origin: String(request.origin),
      path: request.path.split("?")[0],
      name: error?.name,
      code: error?.code,
    });
  const connected = ({ socket }) =>
    record({ event: "connected", socket: socketId(socket) });
  const sendChannel = channel("undici:client:sendHeaders"),
    errorChannel = channel("undici:request:error"),
    connectedChannel = channel("undici:client:connected");
  sendChannel.subscribe(sent);
  errorChannel.subscribe(failed);
  connectedChannel.subscribe(connected);
  return {
    close() {
      active = false;
      sendChannel.unsubscribe(sent);
      errorChannel.unsubscribe(failed);
      connectedChannel.unsubscribe(connected);
      for (const remove of listeners) remove();
      return events;
    },
  };
}
