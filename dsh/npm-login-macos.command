#!/usr/bin/env bash

set -u

REGISTRY="https://registry.npmjs.org/"

pause_before_exit() {
  printf "\nPress Enter to close this window..."
  read -r _ || true
}

if ! command -v npm >/dev/null 2>&1; then
  printf "Error: npm was not found on PATH. Install Node.js and try again.\n" >&2
  pause_before_exit
  exit 1
fi

printf "Logging in to %s\n" "$REGISTRY"
printf "npm may open a browser to complete authentication.\n\n"

if ! npm login --registry="$REGISTRY"; then
  printf "\nError: npm login failed.\n" >&2
  pause_before_exit
  exit 1
fi

if ! NPM_USER="$(npm whoami --registry="$REGISTRY")"; then
  printf "\nError: login finished, but npm whoami could not verify the account.\n" >&2
  pause_before_exit
  exit 1
fi

printf "\nAuthenticated npm account: %s\n" "$NPM_USER"
printf "Registry: %s\n" "$REGISTRY"
pause_before_exit
