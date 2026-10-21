#!/usr/bin/env bash
# Stops what scripts/demo-up.sh started, and only that (its state directory records every PID and
# the container id): the autopilot first (`autopilot stop`), then the container, market-sim, the
# sponsor and, after a rehearsal, the mock Bot API and the anvil fork. Safe to run again.
#
# Env: DEMO_STATE_DIR (default ~/.mantle-meme-demo).
set -uo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE=${DEMO_STATE_DIR:-$HOME/.mantle-meme-demo}
say() { echo "demo-down: $*"; }

if [ -f "$STATE/container" ]; then
  id=$(cat "$STATE/container")
  name=$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)
  if [ -n "$name" ]; then
    name=${name#/}
    if [ "$(docker inspect -f '{{.State.Running}}' "$id")" = true ]; then
      say "stopping the autopilot"
      docker exec "$id" node /opt/mantle-meme/packages/cli/dist/bin/mantle-meme.js autopilot stop --json ||
        true # exit 44: none running
    fi
    say "removing container $name"
    # The gateway drains running turns first; after 30 s Docker stops it.
    docker compose -p "$name" -f "$REPO/docker/openclaw/compose.yaml" down -t 30
  fi
  rm -f "$STATE/container"
fi

# name: what its command line contains (a reused PID is left alone)
for p in market-sim:market-sim sponsor:"sponsor serve" mock-telegram:mock-telegram anvil:anvil; do
  file=$STATE/${p%%:*}.pid
  [ -f "$file" ] || continue
  pid=$(cat "$file")
  if ps -p "$pid" -o command= 2>/dev/null | grep -q -- "${p#*:}"; then
    say "stopping ${p%%:*} (pid $pid)"
    kill "$pid"
    for _ in $(seq 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  fi
  rm -f "$file"
done
say "done"
