"""Bounded, opaque byte forwarding. Never interpret, record or replay CUA input."""
import os
import select


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
