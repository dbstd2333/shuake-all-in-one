# SPDX-License-Identifier: AGPL-3.0-or-later
"""Per-process traffic counters, reported to the host as ``stats`` messages.

Every HTTP client used by the adapters (requests / urllib3 / urllib) ends up in
``http.client``, so counting there covers all of them without touching
upstream code:

* sent bytes: ``HTTPConnection.send`` (request line, headers and body);
* received bytes: the socket file wrapped by ``HTTPResponse`` (status line,
  headers and body, after TLS decryption).

TLS and TCP overhead is not included, so the numbers are a few percent lower
than what the network interface sees. The host also reads the interface
counters for the exact machine-wide total.
"""
from __future__ import annotations

import http.client
import threading
from typing import Any

from . import ipc

INTERVAL = 5.0

_lock = threading.Lock()
_rx = 0
_tx = 0
_reported = (0, 0)
_installed = False
_stop = threading.Event()


def add(rx: int = 0, tx: int = 0) -> None:
    global _rx, _tx
    if rx <= 0 and tx <= 0:
        return
    with _lock:
        _rx += max(rx, 0)
        _tx += max(tx, 0)


def totals() -> tuple[int, int]:
    with _lock:
        return _rx, _tx


def _size(data: Any) -> int:
    if isinstance(data, (bytes, bytearray)):
        return len(data)
    if isinstance(data, memoryview):
        return data.nbytes
    if isinstance(data, str):
        return len(data.encode("utf-8", "ignore"))
    return 0  # file objects / iterables are passed back to send() block by block


class _CountingReader:
    """Wraps the socket file of an HTTPResponse and counts what is read."""

    __slots__ = ("_raw",)

    def __init__(self, raw: Any) -> None:
        self._raw = raw

    def read(self, *args: Any) -> bytes:
        b = self._raw.read(*args)
        add(rx=len(b or b""))
        return b

    def read1(self, *args: Any) -> bytes:
        b = self._raw.read1(*args)
        add(rx=len(b or b""))
        return b

    def readline(self, *args: Any) -> bytes:
        b = self._raw.readline(*args)
        add(rx=len(b or b""))
        return b

    def readinto(self, buf: Any) -> int:
        n = self._raw.readinto(buf)
        add(rx=n or 0)
        return n

    def readinto1(self, buf: Any) -> int:
        n = self._raw.readinto1(buf)
        add(rx=n or 0)
        return n

    def __iter__(self):
        return self

    def __next__(self) -> bytes:
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def __getattr__(self, name: str) -> Any:
        return getattr(self._raw, name)


def report(force: bool = False) -> None:
    """Send the totals if they changed since the last report."""
    global _reported
    cur = totals()
    if cur == _reported and not force:
        return
    _reported = cur
    ipc.send({"type": "stats", "rx": cur[0], "tx": cur[1]})


def _loop() -> None:
    while not _stop.wait(INTERVAL):
        try:
            report()
        except Exception:  # noqa: BLE001 - stdout gone: nothing to report to
            return


def install(start_reporter: bool = True) -> None:
    """Patch http.client once and start the periodic reporter."""
    global _installed
    if _installed:
        return
    _installed = True

    orig_send = http.client.HTTPConnection.send

    def send(self, data):  # type: ignore[no-untyped-def]
        add(tx=_size(data))
        return orig_send(self, data)

    http.client.HTTPConnection.send = send  # type: ignore[method-assign]

    orig_init = http.client.HTTPResponse.__init__

    def init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        orig_init(self, *args, **kwargs)
        if self.fp is not None and not isinstance(self.fp, _CountingReader):
            self.fp = _CountingReader(self.fp)

    http.client.HTTPResponse.__init__ = init  # type: ignore[method-assign]

    if start_reporter:
        threading.Thread(target=_loop, name="traffic-reporter", daemon=True).start()
