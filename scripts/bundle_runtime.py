#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Copy the prepared Python runtime and the engine into an app bundle.

    python3 scripts/bundle_runtime.py --target darwin-arm64 --dest "bin/App.app/Contents/Resources/runtime"
    python3 scripts/bundle_runtime.py --target windows-amd64 --dest bin/runtime

On macOS, every Mach-O file inside is (re)signed: ad-hoc by default, or with
--identity "Developer ID Application: ..." (hardened runtime + timestamp) for
notarization.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", "tests", "patches", ".DS_Store", "*.md.bak")
MACHO_MAGIC = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf"}


def is_macho(p: Path) -> bool:
    try:
        with open(p, "rb") as fh:
            return fh.read(4) in MACHO_MAGIC
    except OSError:
        return False


def sign_tree(root: Path, identity: str | None, entitlements: Path | None) -> None:
    files = [p for p in root.rglob("*") if p.is_file() and not p.is_symlink() and is_macho(p)]
    print(f"  signing {len(files)} Mach-O files ({identity or 'ad-hoc'})")
    base = ["codesign", "--force", "--sign", identity or "-"]
    if identity:
        base += ["--options", "runtime", "--timestamp"]
    for f in files:
        cmd = list(base)
        if entitlements and f.name.startswith("python"):
            cmd += ["--entitlements", str(entitlements)]
        subprocess.run(cmd + [str(f)], check=True, capture_output=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True)
    ap.add_argument("--dest", required=True)
    ap.add_argument("--identity", default=None)
    args = ap.parse_args()

    src_py = ROOT / "build" / "runtime" / args.target / "python"
    if not src_py.exists():
        sys.exit(f"{src_py} missing — run: python3 scripts/prepare_runtime.py --target {args.target}")
    dest = Path(args.dest)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    print(f"  copying python -> {dest / 'python'}")
    shutil.copytree(src_py, dest / "python", symlinks=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    print(f"  copying engine -> {dest / 'engine'}")
    shutil.copytree(ROOT / "engine", dest / "engine", ignore=IGNORE)
    for name in ("requirements.in",):
        (dest / "engine" / name).unlink(missing_ok=True)
    if args.target.startswith("darwin") and sys.platform == "darwin":
        ent = ROOT / "build" / "darwin" / "python.entitlements"
        sign_tree(dest, args.identity, ent if ent.exists() else None)


if __name__ == "__main__":
    main()
