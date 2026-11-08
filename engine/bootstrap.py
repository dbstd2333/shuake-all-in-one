# SPDX-License-Identifier: AGPL-3.0-or-later
"""Launcher used by the Go host: ``python -I -X utf8 -u bootstrap.py``.

``-I`` ignores PYTHONPATH and the script directory, so the engine and the
vendored upstream projects are put on ``sys.path`` explicitly here.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from shuake_engine.main import main  # noqa: E402

main()
