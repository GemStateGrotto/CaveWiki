#!/bin/bash
set -e

# Ensure mounted secrets are exported in every new terminal.
# Uses tr -d '\r' to handle Windows-style line endings in the secrets file.
SECRETS="$HOME/.secrets/cavewiki"
if ! grep -q "$SECRETS" ~/.bashrc 2>/dev/null; then
    cat >> ~/.bashrc <<BASHRC

# Export secrets from mounted file (if present)
if [ -f "$SECRETS" ]; then
    set -a
    source <(tr -d '\\r' < "$SECRETS" | grep -v '^\\s*#' | grep -v '^\\s*$')
    set +a
fi
BASHRC
fi