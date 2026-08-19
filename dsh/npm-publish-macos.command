#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  printf "Error: node was not found on PATH. Install Node.js and try again.\n" >&2
  printf "\nPress Enter to close this window..."
  read -r _ || true
  exit 1
fi

exec node "$SCRIPT_DIR/npm-publish.mjs"
