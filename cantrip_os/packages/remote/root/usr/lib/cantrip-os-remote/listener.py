"""Bounded guest-loopback listener over an already authorized root carrier.

The external Worker owns the Host destination. No Host address, credentials or
orchestration is installed here. Each accepted guest TCP connection has its own
64 KiB credit windows in the protected multiplexed stream.
"""
import json
import os
from pathlib import Path
import selectors
import socket
import struct

WINDOW = 65536
MAX_CLIENTS = 16
MAX_BUFFER = 2 * 1024 * 1024


def integer(value, minimum=1, maximum=WINDOW):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Invalid listener frame integer")
    return value


def pump(port, ready, stopping):
    selector = selectors.DefaultSelector()
    listener = socket.socket()
    clients = {}
    incoming, outgoing = bytearray(), bytearray()
    next_id = 0
    stdin, stdout = os.sys.stdin.fileno(), os.sys.stdout.fileno()

    def emit(kind, ident, payload=b"", **fields):
        header = json.dumps({"type": kind, "id": ident, **fields}, separators=(",", ":")).encode()
        if len(payload) > WINDOW or len(header) > 1024:
            raise ValueError("Listener frame exceeds its bound")
        outgoing.extend(struct.pack("!II", len(header), len(payload)) + header + payload)
        if len(outgoing) > MAX_BUFFER:
            raise RuntimeError("Listener output exceeded its bound")
        try:
            selector.modify(stdout, selectors.EVENT_WRITE, "stdout")
        except KeyError:
            selector.register(stdout, selectors.EVENT_WRITE, "stdout")

    def watch(client):
        events = (selectors.EVENT_READ if client["accepted"] and not client["read_eof"] and client["credit"] else 0)
        if client["pending"]:
            events |= selectors.EVENT_WRITE
        if not events:
            try:
                selector.unregister(client["socket"])
            except KeyError:
                pass
        else:
            try:
                selector.modify(client["socket"], events, client)
            except KeyError:
                selector.register(client["socket"], events, client)

    def drop(client, notify=True):
        if clients.pop(client["id"], None) is not client:
            return
        try:
            selector.unregister(client["socket"])
        except KeyError:
            pass
        client["socket"].close()
        if notify:
            emit("close", client["id"])

    def finish(client):
        if client["write_eof"] and not client["pending"] and not client["write_closed"]:
            client["socket"].shutdown(socket.SHUT_WR)
            client["write_closed"] = True
        if client["read_eof"] and client["write_closed"]:
            drop(client)
        else:
            watch(client)

    def receive(header, payload):
        if not isinstance(header, dict):
            raise ValueError("Invalid listener frame")
        ident = integer(header.get("id"), maximum=2147483647)
        kind = header.get("type")
        expected = {"type", "id", "credit"} if kind == "accepted" else \
            {"type", "id", "bytes"} if kind == "credit" else {"type", "id"}
        if set(header) != expected or kind not in ("accepted", "credit", "data", "fin", "close") or \
                (kind != "data" and payload):
            raise ValueError("Invalid listener frame fields")
        client = clients.get(ident)
        if client is None:  # Late frames cannot act on a reused connection ID.
            return
        if kind == "accepted":
            if client["accepted"] or integer(header["credit"]) != WINDOW:
                raise ValueError("Listener connection accepted more than once")
            client["accepted"], client["credit"] = True, WINDOW
        elif kind == "credit":
            amount = integer(header["bytes"])
            if not client["accepted"] or client["credit"] + amount > WINDOW:
                raise ValueError("Listener credit escaped its window")
            client["credit"] += amount
        elif kind == "data":
            if not client["accepted"] or client["write_eof"] or not payload or len(payload) > client["receive_credit"]:
                raise ValueError("Listener data escaped its window")
            client["receive_credit"] -= len(payload)
            client["pending"].extend(payload)
        elif kind == "fin":
            if not client["accepted"] or client["write_eof"]:
                raise ValueError("Invalid listener half-close")
            client["write_eof"] = True
        else:
            drop(client, False)
            return
        finish(client)

    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen(MAX_CLIENTS)
        listener.setblocking(False)
        os.set_blocking(stdin, False)
        os.set_blocking(stdout, False)
        selector.register(stdin, selectors.EVENT_READ, "stdin")
        selector.register(listener, selectors.EVENT_READ, "listener")
        Path(ready).write_text('{"ready":true}\n')
        while not stopping():
            for key, events in selector.select(.2):
                if key.data == "stdin":
                    data = os.read(stdin, WINDOW)
                    if not data:
                        return
                    incoming.extend(data)
                    if len(incoming) > MAX_BUFFER:
                        raise ValueError("Listener input exceeded its bound")
                    while len(incoming) >= 8:
                        header_size, payload_size = struct.unpack("!II", incoming[:8])
                        if not 1 <= header_size <= 1024 or payload_size > WINDOW:
                            raise ValueError("Listener frame exceeds its bound")
                        size = 8 + header_size + payload_size
                        if len(incoming) < size:
                            break
                        header = json.loads(incoming[8:8 + header_size])
                        payload = bytes(incoming[8 + header_size:size])
                        del incoming[:size]
                        receive(header, payload)
                elif key.data == "stdout":
                    try:
                        count = os.write(stdout, outgoing)
                        del outgoing[:count]
                    except BlockingIOError:
                        continue
                    if not outgoing:
                        selector.unregister(stdout)
                elif key.data == "listener":
                    connection, _ = listener.accept()
                    if len(clients) >= MAX_CLIENTS or next_id >= 2147483647:
                        connection.close()
                        continue
                    next_id += 1
                    connection.setblocking(False)
                    client = {"id": next_id, "socket": connection, "accepted": False,
                              "credit": 0, "receive_credit": WINDOW, "pending": bytearray(),
                              "read_eof": False, "write_eof": False, "write_closed": False}
                    clients[next_id] = client
                    emit("open", next_id, credit=WINDOW)
                else:
                    client = key.data
                    if clients.get(client["id"]) is not client:
                        continue
                    try:
                        if events & selectors.EVENT_WRITE:
                            count = client["socket"].send(client["pending"])
                            del client["pending"][:count]
                            if count:
                                client["receive_credit"] += count
                                emit("credit", client["id"], bytes=count)
                        if events & selectors.EVENT_READ:
                            data = client["socket"].recv(min(client["credit"], WINDOW))
                            if data:
                                client["credit"] -= len(data)
                                emit("data", client["id"], data)
                            else:
                                client["read_eof"] = True
                                emit("fin", client["id"])
                        finish(client)
                    except (ConnectionError, OSError):
                        drop(client)
    finally:
        for client in list(clients.values()):
            drop(client, False)
        listener.close()
        selector.close()
