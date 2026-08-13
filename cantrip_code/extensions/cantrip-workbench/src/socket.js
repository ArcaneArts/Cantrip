"use strict";

/**
 * Observe WebSocket failures without mutating the socket from its error event.
 *
 * Node's WebSocket implementation may dispatch another synchronous error when
 * close() is called while the connection is still opening. Let the subsequent
 * close event own cleanup and reconnect scheduling instead.
 */
function observeSocketErrors(socket, observer) {
  socket.addEventListener("error", () => observer(socket.readyState));
}

module.exports = { observeSocketErrors };
