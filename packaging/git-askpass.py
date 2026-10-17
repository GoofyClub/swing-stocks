#!/usr/bin/env python3
"""Pass the optional private-repository credential only to native Git."""
import os
import sys

if "username" in sys.argv[-1].lower():
    print("x-access-token")
else:
    print(os.environ.get("SWING_GITHUB_TOKEN", ""))
