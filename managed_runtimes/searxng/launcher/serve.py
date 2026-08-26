#!/usr/bin/env python3
"""Launch the bundled SearXNG without consulting host Python state."""

from __future__ import annotations

import argparse
import os
import pathlib
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1", choices=("127.0.0.1", "::1"))
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--settings", type=pathlib.Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("port must be between 1 and 65535")

    runtime_root = pathlib.Path(__file__).resolve().parents[1]
    app_root = (runtime_root / "app" / "searxng").resolve(strict=True)
    settings = args.settings.resolve(strict=True)
    sys.path.insert(0, str(app_root))

    os.environ["SEARXNG_SETTINGS_PATH"] = str(settings)
    os.environ["SEARXNG_DISABLE_ETC_SETTINGS"] = "1"
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    os.environ.setdefault("PYTHONNOUSERSITE", "1")

    from searx.webapp import app  # pylint: disable=import-outside-toplevel
    from waitress import serve  # pylint: disable=import-outside-toplevel

    serve(app, host=args.host, port=args.port, threads=4, ident="Cantrip Search")


if __name__ == "__main__":
    main()
