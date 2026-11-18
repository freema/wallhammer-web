#!/bin/sh
# Runs the whole measurement set one after another (never two browsers at once), with rests against thermal drift.
# Usage: sh run-all.sh [out-dir]    (on the host, pages running: docker compose up -d in the repository root)
set -e
cd "$(dirname "$0")"
OUT="${1:-out}"
rest() { sleep "${REST:-30}"; }
node bench.mjs counts --page destruction --out "$OUT"; rest
node bench.mjs counts --page endless --out "$OUT"; rest
node bench.mjs frames --page destruction --out "$OUT"; rest
node bench.mjs frames --page endless --out "$OUT"; rest
node bench.mjs startup --page destruction --out "$OUT"; rest
node bench.mjs startup --page endless --out "$OUT"; rest
node bench.mjs flight --src workers --out "$OUT"; rest
node bench.mjs flight --src main --out "$OUT"; rest
node bench.mjs memory --page endless --reps 2 --out "$OUT"
echo done
