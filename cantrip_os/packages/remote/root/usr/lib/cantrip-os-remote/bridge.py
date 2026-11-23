"""Bounded, opaque byte forwarding. Never interpret, record or replay CUA input."""
import os
import select


def stream_pump(left_read, left_write, right_read, right_write, stopped=lambda: False,
                close_left=lambda: None, close_right=lambda: None):
    """Bounded duplex forwarding, retaining replies after a request half-close."""
    routes = [[left_read, right_write, bytearray(), False, False, close_right],
              [right_read, left_write, bytearray(), False, False, close_left]]
    for fd in {left_read, left_write, right_read, right_write}:
        os.set_blocking(fd, False)
    while not stopped():
        for route in routes:
            if route[3] and not route[2] and not route[4]:
                route[5]()
                route[4] = True
        if all(route[4] for route in routes):
            return
        readers = [source for source, _, pending, eof, _, _ in routes if not eof and len(pending) < 65536]
        writers = [destination for _, destination, pending, _, _, _ in routes if pending]
        readable, writable, _ = select.select(readers, writers, [], .1)
        for route in routes:
            source, destination, pending = route[:3]
            if source in readable:
                try:
                    data = os.read(source, 65536 - len(pending))
                except BlockingIOError:
                    continue
                if data:
                    pending.extend(data)
                else:
                    route[3] = True
            if destination in writable and pending:
                try:
                    count = os.write(destination, pending)
                except BlockingIOError:
                    continue
                del pending[:count]


def pump(left_read, left_write, right_read, right_write, stopped=lambda: False):
    # Each source has at most one bounded chunk awaiting its destination.
    routes = [(left_read, right_write, bytearray()), (right_read, left_write, bytearray())]
    for fd in {left_read, left_write, right_read, right_write}:
        os.set_blocking(fd, False)
    while not stopped():
        readers = [source for source, _, pending in routes if len(pending) < 65536]
        writers = [destination for _, destination, pending in routes if pending]
        readable, writable, _ = select.select(readers, writers, [], .1)
        for source, destination, pending in routes:
            if source in readable:
                try:
                    data = os.read(source, 65536 - len(pending))
                except BlockingIOError:
                    continue
                if not data:
                    return
                pending.extend(data)
            if destination in writable and pending:
                try:
                    count = os.write(destination, pending)
                except BlockingIOError:
                    continue
                del pending[:count]
