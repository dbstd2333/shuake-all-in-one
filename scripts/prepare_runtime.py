#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Prepare the bundled CPython runtime for a target platform.

Downloads a python-build-standalone release, verifies its SHA256, extracts it to
``build/runtime/<target>/python`` and installs ``engine/requirements.lock`` into
its site-packages using ``uv`` (cross-platform wheels, binary only).

Usage:
    python3 scripts/prepare_runtime.py                 # host target
    python3 scripts/prepare_runtime.py --target windows-amd64
    python3 scripts/prepare_runtime.py --target all
"""
from __future__ import annotations

import argparse
import hashlib
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

PBS_TAG = "20261026"
PY_VERSION = "3.12.16"

TARGETS = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-amd64": "x86_64-apple-darwin",
    "windows-amd64": "x86_64-pc-windows-msvc",
    "windows-arm64": "aarch64-pc-windows-msvc",
}

# Parts of the stdlib that the engine never uses.
STRIP_DIRS = [
    "test", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3",
    "pydoc_data", "unittest/test",
]

NATIVE_PACKAGES = ["numpy", "opencv-python-headless", "lxml", "pycryptodome", "wrapt", "charset-normalizer"]

ROOT = Path(__file__).resolve().parent.parent
BASE_URL = f"https://github.com/astral-sh/python-build-standalone/releases/download/{PBS_TAG}"


def host_target() -> str:
    os_name = {"Darwin": "darwin", "Windows": "windows"}.get(platform.system())
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "AMD64": "amd64"}.get(platform.machine())
    if not os_name or not arch:
        sys.exit(f"unsupported host: {platform.system()} {platform.machine()}")
    return f"{os_name}-{arch}"


def download(url: str, dest: Path) -> None:
    if dest.exists():
        return
    print(f"  downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as fh:
        shutil.copyfileobj(resp, fh)
    tmp.rename(dest)


def expected_sha256(asset: str, cache: Path) -> str:
    sums = cache / f"SHA256SUMS-{PBS_TAG}"
    download(f"{BASE_URL}/SHA256SUMS", sums)
    for line in sums.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == asset:
            return parts[0]
    sys.exit(f"no checksum for {asset}")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def site_packages(py_root: Path, target: str) -> Path:
    if target.startswith("windows"):
        return py_root / "Lib" / "site-packages"
    return py_root / "lib" / "python3.12" / "site-packages"


def stdlib_dir(py_root: Path, target: str) -> Path:
    if target.startswith("windows"):
        return py_root / "Lib"
    return py_root / "lib" / "python3.12"


# The VC++ runtime (redistributable per the Visual Studio license) that
# opencv-python needs but neither the wheels nor python-build-standalone ship.
MSVC_DLLS = ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "concrt140.dll", "vcomp140.dll"]


def bundle_msvc_runtime(py_root: Path, target: str) -> None:
    import os

    if platform.system() != "Windows":
        print("  NOTE: msvcp140.dll can only be bundled when preparing on Windows (CI does this).")
        return
    sysdir = Path(os.environ.get("SystemRoot", r"C:\Windows")) / ("System32" if target.endswith("amd64") or target.endswith("arm64") else "SysWOW64")
    for name in MSVC_DLLS:
        src = sysdir / name
        if src.exists():
            shutil.copy2(src, py_root / name)
            print(f"  bundled {name}")
        else:
            print(f"  WARNING: {src} not found")


def prepare(target: str, force: bool) -> None:
    triple = TARGETS[target]
    asset = f"cpython-{PY_VERSION}+{PBS_TAG}-{triple}-install_only_stripped.tar.gz"
    cache = ROOT / "build" / "runtime" / ".cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / asset
    out = ROOT / "build" / "runtime" / target
    py_root = out / "python"

    print(f"[{target}] python-build-standalone {PY_VERSION}+{PBS_TAG}")
    download(f"{BASE_URL}/{asset.replace('+', '%2B')}", archive)
    want = expected_sha256(asset, cache)
    got = sha256(archive)
    if got != want:
        archive.unlink()
        sys.exit(f"checksum mismatch for {asset}: {got} != {want}")

    if py_root.exists():
        if not force:
            print(f"  {py_root} exists (use --force to rebuild); reinstalling packages only")
        else:
            shutil.rmtree(py_root)
    if not py_root.exists():
        out.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as tf:
            tf.extractall(out, filter="data")  # archive root is "python/"

    stdlib = stdlib_dir(py_root, target)
    for rel in STRIP_DIRS:
        shutil.rmtree(stdlib / rel, ignore_errors=True)

    sp = site_packages(py_root, target)
    sp.mkdir(parents=True, exist_ok=True)
    cmd = [
        "uv", "pip", "install",
        "--target", str(sp),
        "--python-version", "3.12",
        "--python-platform", triple,
        # Native packages must come as wheels for the *target* platform; pure
        # Python sdists (e.g. pyaes) are built locally, which is platform neutral.
        *[a for pkg in NATIVE_PACKAGES for a in ("--only-binary", pkg)],
        "--no-compile",
        "-r", str(ROOT / "engine" / "requirements.lock"),
    ]
    print("  " + " ".join(cmd))
    subprocess.run(cmd, check=True)

    if target.startswith("windows"):
        bundle_msvc_runtime(py_root, target)

    removed = 0
    for cache_dir in py_root.rglob("__pycache__"):
        shutil.rmtree(cache_dir, ignore_errors=True)
        removed += 1
    size = sum(f.stat().st_size for f in py_root.rglob("*") if f.is_file())
    print(f"  done: {py_root} ({size / 1e6:.0f} MB, removed {removed} __pycache__ dirs)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=host_target(), choices=[*TARGETS, "all"])
    ap.add_argument("--force", action="store_true", help="re-extract the interpreter")
    args = ap.parse_args()
    if shutil.which("uv") is None:
        sys.exit("uv is required: https://docs.astral.sh/uv/")
    targets = list(TARGETS) if args.target == "all" else [args.target]
    for t in targets:
        prepare(t, args.force)


if __name__ == "__main__":
    main()
