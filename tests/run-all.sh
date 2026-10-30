#!/usr/bin/env bash
# Full local verification: types, unit tests, production build, end-to-end suite.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Typecheck"
npx tsc --noEmit

echo "==> Unit tests"
npm run test:unit -- --run

echo "==> Production build"
npm run build

echo "==> Integration tests"
bash tests/run-integration.sh

echo "All checks passed."
