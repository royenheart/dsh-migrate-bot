#!/bin/bash
# The reference solution: the author's migration commit, applied to the fixture.
set -euo pipefail
cd /app
git apply --whitespace=nowarn --directory=fixture /solution/migration.patch
