#!/usr/bin/env bash
# Installs Ollama (the free local AI runner) if it is missing, then downloads a model that fits THIS computer's memory.
# Run it yourself, once:   bash install-ollama.sh        (add DRY_RUN=1 to only print what it would do)
# Afterwards open TV Hub > Assistant > "Set up Ollama" and tap the model: that is the whole connection.
set -u
DRY="${DRY_RUN:-0}"
say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = "1" ]; then say "[dry-run] $*"; else eval "$@"; fi; }

# memory in GB
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then RAM=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
else RAM=$(awk '/MemTotal/ {print int($2/1048576)}' /proc/meminfo 2>/dev/null || echo 0); fi
RAM="${RAM:-0}"
# same rule as the program itself (assistant.js recommendModel)
if   [ "$RAM" -le 0 ];  then MODEL="qwen2.5:3b"
elif [ "$RAM" -lt 6 ];  then MODEL="qwen2.5:1.5b"
elif [ "$RAM" -lt 12 ]; then MODEL="qwen2.5:3b"
else MODEL="qwen2.5:7b"; fi
say "System: $OS, memory about ${RAM} GB -> model: $MODEL"

if command -v ollama >/dev/null 2>&1; then
  say "Ollama is already installed."
else
  if [ "$OS" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then run "brew install ollama"
    else say "Install the Ollama app from https://ollama.com/download then run this script again."; [ "$DRY" = "1" ] || exit 1; fi
  else
    say "Installing with the official script (https://ollama.com/install.sh); it may ask for your password."
    run "curl -fsSL https://ollama.com/install.sh | sh"
  fi
fi

# the server must be running for a model to be downloaded
if [ "$DRY" != "1" ] && ! curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
  say "Starting Ollama..."; (nohup ollama serve >/dev/null 2>&1 &); sleep 4
fi
run "ollama pull $MODEL"
say ""
say "Done. In TV Hub open: Assistant > Set up Ollama > tap  $MODEL"
