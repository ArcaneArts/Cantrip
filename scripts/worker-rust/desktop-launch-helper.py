"""Change the deterministic helper window after the fixture launcher runs."""

from pathlib import Path
import struct
import subprocess
import sys
from threading import Thread


def forward(source, destination, transform):
    while lengths := source.read(8):
        header_size, payload_size = struct.unpack(">II", lengths)
        header = source.read(header_size)
        payload = source.read(payload_size)
        header = transform(header)
        destination.write(struct.pack(">II", len(header), len(payload)))
        destination.write(header)
        destination.write(payload)
        destination.flush()


def helper_request(header):
    return header.replace(b'"launched-window"', b'"fake-window"')


def helper_reply(header):
    if not receipt.exists():
        return header
    return header.replace(b'"fake-window"', b'"launched-window"').replace(
        b'"Cantrip CUA fixture"', b'"Cantrip launch fixture"'
    )


receipt = Path(sys.argv[2])
with subprocess.Popen(
    [sys.argv[1], "--backend", "fake"], stdin=subprocess.PIPE, stdout=subprocess.PIPE
) as helper:
    def requests():
        try:
            forward(sys.stdin.buffer, helper.stdin, helper_request)
        finally:
            helper.stdin.close()

    Thread(target=requests, daemon=True).start()
    forward(helper.stdout, sys.stdout.buffer, helper_reply)
    sys.exit(helper.wait())
