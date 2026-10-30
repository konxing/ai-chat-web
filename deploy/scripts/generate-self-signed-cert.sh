#!/usr/bin/env bash
# Local/staging only: create a self-signed certificate for the Nginx edge.
# Production must use a real CA certificate (e.g. Let's Encrypt).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT_DIR:-$ROOT/deploy/nginx/ssl}"
CN="${CN:-localhost}"

mkdir -p "$OUT"
chmod 700 "$OUT"
openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days "${DAYS:-365}" \
  -keyout "$OUT/privkey.pem" \
  -out "$OUT/fullchain.pem" \
  -subj "/CN=${CN}" \
  -addext "subjectAltName=DNS:${CN},IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$OUT/privkey.pem"
chmod 644 "$OUT/fullchain.pem"
echo "Self-signed certificate written to $OUT (CN=${CN})."
echo "Browsers will warn; use only for local testing."
