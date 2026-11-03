"""JSON-line carrier over native authenticated WebSocket. Does not interpret RPCs."""
import sys
import threading
import websocket


def bridge(endpoint):
    connection = websocket.create_connection(endpoint["url"],
        header={"Authorization": "Bearer " + endpoint["token"]}, suppress_origin=True,
        http_no_proxy=["127.0.0.1", "localhost"])
    connection.settimeout(None)

    def incoming():
        try:
            while True:
                line = sys.stdin.buffer.readline(16 * 1024 * 1024 + 1)
                if not line:
                    break
                if len(line) > 16 * 1024 * 1024 or not line.endswith(b"\n"):
                    raise ValueError("Executor frame exceeds transport limit")
                connection.send(line.decode().rstrip("\n"))
        finally:
            connection.close()

    threading.Thread(target=incoming, daemon=True).start()
    try:
        while True:
            try:
                message = connection.recv()
            except websocket.WebSocketConnectionClosedException:
                # EOF also closes the socket from the input thread. The worker
                # still observes carrier closure and unknown pending outcomes.
                break
            if not message:
                break
            if not isinstance(message, str):
                raise ValueError("Expected a JSON text frame")
            sys.stdout.write(message + "\n")
            sys.stdout.flush()
    finally:
        connection.close()
