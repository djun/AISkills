#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf "Error: node and npm must be available on PATH. Install Node.js and try again.\n" >&2
  printf "\nPress Enter to close this window..."
  read -r _ || true
  exit 1
fi

npm --prefix "$SCRIPT_DIR/.." run emit:dsh-release || exit $?
exec node "$SCRIPT_DIR/build/npm-publish.mjs"
