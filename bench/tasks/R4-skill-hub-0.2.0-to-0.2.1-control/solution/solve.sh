#!/bin/bash
# The reference solution: the author's migration commit, then the peer ranges it left out (README.md), applied to the fixture.
set -euo pipefail
cd /app
git apply --whitespace=nowarn --directory=fixture /solution/migration.patch
git apply --whitespace=nowarn --directory=fixture /solution/peer-ranges.patch
