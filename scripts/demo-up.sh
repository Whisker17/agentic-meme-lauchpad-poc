#!/usr/bin/env bash
# Starts the agent side of the Telegram demo (docs/demo.md, DESIGN §9.2): `mantle-aa sponsor serve`
# and market-sim on this machine, and the OpenClaw container (gateway + Telegram channel + the
# autopilot launcher, docker/openclaw). Every PID and the container id go to the state directory,
# so scripts/demo-down.sh stops exactly those.
#
#   scripts/demo-up.sh sponsor   only the sponsor (and, with DEMO_FORK=1, the fork): for the
#                                human's setup, which sends through it
#   scripts/demo-up.sh           everything (what already runs is kept)
#
# Env (key material is only ever read from the files named here, never printed):
#   DEMO_ACCOUNT                 the human's account (root key address): the sponsor's allowlist
#   DEMO_RELAYER_KEY_FILE        the sponsor's relayer key (a file holding one 0x… key, bare or
#                                as KEY=0x…); the relayer pays all gas of the account
#   MARKET_SIM_MNEMONIC_FILE     market-sim's mnemonic; its EOAs 0..2 pay their own gas
#   DEMO_AGENT_PASSWORD_FILE     the agent home's password (MANTLE_AA_EXPORT_PASSWORD at export)
#   DEMO_TELEGRAM_ENV_FILE       MANTLE_MEME_TG_BOT_TOKEN and MANTLE_MEME_TG_CHAT_ID (default
#                                ~/.mantle-aa/keys/meme-demo-telegram.env; exported values win)
#   MANTLE_MEME_AGENT_HOME       the exported agent home (default ~/.mantle-meme-agent)
#   MANTLE_MEME_OPENCLAW_STATE   OpenClaw's state and model login (default ~/.mantle-meme-openclaw)
#   DEMO_RPC_URL                 the chain (default https://rpc.sepolia.mantle.xyz), reached through
#                                a local relay on 127.0.0.1:8547 (scripts/rpc-relay.mjs)
#   DEMO_STATE_DIR               PIDs, logs, the sponsor's config and ledger (default ~/.mantle-meme-demo)
#   DEMO_SPONSOR_PORT            default 8548
#   DEMO_CONTAINER               the container's name (default mantle-meme-openclaw)
#   DEMO_MARKET_SIM_ARGS         `market-sim run` options (default --wallets 2 --create-every 60-120:
#                                wallets 0 and 1, so the human's `market-sim pump --wallet 2` has its own)
#   DEMO_MOCK_TELEGRAM=1         a mock Bot API (scripts/mock-telegram.mjs) instead of Telegram
#   DEMO_FORK=1                  rehearsal: an anvil fork of DEMO_RPC_URL, throwaway public anvil
#                                keys (no key files needed) and the mock Bot API
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE=${DEMO_STATE_DIR:-$HOME/.mantle-meme-demo}
RPC=${DEMO_RPC_URL:-https://rpc.sepolia.mantle.xyz}
PORT=${DEMO_SPONSOR_PORT:-8548}
CONTAINER=${DEMO_CONTAINER:-mantle-meme-openclaw}
AGENT_HOME=${MANTLE_MEME_AGENT_HOME:-$HOME/.mantle-meme-agent}
OC_STATE=${MANTLE_MEME_OPENCLAW_STATE:-$HOME/.mantle-meme-openclaw}
COMPOSE=(docker compose -p "$CONTAINER" -f "$REPO/docker/openclaw/compose.yaml")
AA="$REPO/packages/cli/node_modules/.bin/mantle-aa"
SIM="$REPO/tools/market-sim/dist/bin.js"
SIM_ARGS=${DEMO_MARKET_SIM_ARGS:---wallets 2 --create-every 60-120}
MOCK=${DEMO_MOCK_TELEGRAM:-}
[ "${DEMO_FORK:-}" = 1 ] && MOCK=1

die() {
  echo "demo-up: $*" >&2
  echo "demo-up: scripts/demo-down.sh stops whatever was started." >&2
  exit 1
}
say() { echo "demo-up: $*"; }
# A URL of this machine as the container reaches it.
dockerhost() {
  local u=${1//127.0.0.1/host.docker.internal}
  echo "${u//localhost/host.docker.internal}"
}
readable() { [ -n "${!1:-}" ] && [ -r "${!1}" ] || die "$1 must name a readable file"; }
# A PID file whose process is alive and is still the one we started (its command line has $2).
running() { [ -f "$STATE/$1.pid" ] && ps -p "$(cat "$STATE/$1.pid")" -o command= 2>/dev/null | grep -q -- "$2"; }
# Waits up to $1 seconds for the command after it to succeed.
wait_for() {
  local t=$1
  shift
  for ((i = 0; i < t; i++)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

[ -f "$AA" ] && [ -f "$SIM" ] && [ -f "$REPO/packages/cli/dist/bin/mantle-meme.js" ] ||
  die "build the repository first: pnpm install && pnpm build"
mkdir -p "$STATE" && chmod 700 "$STATE"

if [ "${DEMO_FORK:-}" = 1 ]; then
  # Public anvil test keys: anvil account 4 relays, accounts 0..2 are market-sim.
  printf '%s\n' 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a >"$STATE/fork-relayer.key"
  printf '%s\n' "test test test test test test test test test test test junk" >"$STATE/fork.mnemonic"
  DEMO_RELAYER_KEY_FILE=$STATE/fork-relayer.key
  MARKET_SIM_MNEMONIC_FILE=$STATE/fork.mnemonic
  if ! running anvil anvil; then
    command -v anvil >/dev/null || die "DEMO_FORK=1 needs anvil (Foundry)"
    say "starting an anvil fork of $RPC on 127.0.0.1:8545"
    (cd "$STATE" || exit; nohup anvil --fork-url "$RPC" --port 8545 --hardfork prague >anvil.log 2>&1 &
      echo $! >anvil.pid)
    wait_for 60 cast chain-id --rpc-url http://127.0.0.1:8545 || die "anvil did not start: $STATE/anvil.log"
  fi
  RPC=http://127.0.0.1:8545
else
  # The public RPC refuses bursts of calls (rate limit): everything reaches it through a local relay
  # that forwards at most 4 calls at a time and retries refused ones.
  if ! running rpc-relay rpc-relay; then
    say "starting a JSON-RPC relay to the chain on 127.0.0.1:8547"
    (cd "$STATE" || exit; RPC_RELAY_UPSTREAM=$RPC nohup node "$REPO/scripts/rpc-relay.mjs" 8547 \
      >rpc-relay.log 2>&1 &
      echo $! >rpc-relay.pid)
    wait_for 10 grep -q relay "$STATE/rpc-relay.log" || die "the RPC relay did not start: $STATE/rpc-relay.log"
  fi
  RPC=http://127.0.0.1:8547
fi

# --- the sponsor -----------------------------------------------------------------------------------
if running sponsor "sponsor serve"; then
  say "sponsor already running (pid $(cat "$STATE/sponsor.pid"))"
else
  [[ "${DEMO_ACCOUNT:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] ||
    die "DEMO_ACCOUNT must be the human's account address (mantle-aa keys new / keys list)"
  readable DEMO_RELAYER_KEY_FILE
  key=$(grep -oE '0x[0-9a-fA-F]{64}' "$DEMO_RELAYER_KEY_FILE" | head -1) ||
    die "no 0x… private key in DEMO_RELAYER_KEY_FILE"
  relayer=$(cd "$REPO" && K=$key node --input-type=module \
    -e 'import { privateKeyToAddress as a } from "viem/accounts"; console.log(a(process.env.K))')
  if [ "${DEMO_FORK:-}" = 1 ]; then
    cast rpc --rpc-url "$RPC" anvil_setBalance "$relayer" 0x29a2241af62c0000 >/dev/null # 3 MNT
  fi
  # The key is referenced as ${DEMO_RELAYER_KEY} and given only to the sponsor's environment.
  cat >"$STATE/sponsor.yaml" <<EOF
chainId: 5003
rpcUrl: $RPC
listen: { host: 127.0.0.1, port: $PORT }
database: $STATE/sponsor.sqlite
relayer: "$relayer"
relayerKey: \${DEMO_RELAYER_KEY}
settleTimeoutSeconds: 60
policy:
  allowlist: ["$DEMO_ACCOUNT"]
  accountDailyGas: 2000000000
  maxFeePerRequestMnt: "0.3"
  dailyBudgetMnt: "2"
  managementReserveMnt: "0.5"
EOF
  say "starting the sponsor on 127.0.0.1:$PORT (relayer $relayer, account $DEMO_ACCOUNT)"
  (cd "$STATE" || exit; DEMO_RELAYER_KEY=$key nohup env -u MANTLE_AA_HOME -u MANTLE_AA_KEYSTORE_PASSWORD \
    "$AA" sponsor serve --config sponsor.yaml --json >sponsor.out 2>sponsor.log &
    echo $! >sponsor.pid)
  unset key
  wait_for 60 grep -q '"url"' "$STATE/sponsor.out" || die "the sponsor did not start: $STATE/sponsor.log"
fi
if [ "${1:-}" = sponsor ]; then
  say "ready for the human's setup: MANTLE_AA_RPC_URL=$RPC MANTLE_AA_SPONSOR_URL=http://127.0.0.1:$PORT"
  exit 0
fi

# --- prerequisites of the agent side -----------------------------------------------------------------
docker info >/dev/null 2>&1 || die "Docker is not running (start OrbStack or Docker Desktop)"
[ -f "$AGENT_HOME/profiles.json" ] ||
  die "no exported agent home at $AGENT_HOME (mantle-aa session export, docs/demo.md step 1)"
readable DEMO_AGENT_PASSWORD_FILE
readable MARKET_SIM_MNEMONIC_FILE
[ -d "$OC_STATE" ] || die "no OpenClaw state at $OC_STATE (model login: skills/mantle-meme/README.md)"
if [ -n "$MOCK" ]; then
  MANTLE_MEME_TG_BOT_TOKEN=123456:mock MANTLE_MEME_TG_CHAT_ID=1000001
  MANTLE_MEME_TG_API_URL=http://host.docker.internal:8081
  if ! running mock-telegram mock-telegram; then
    say "starting the mock Telegram Bot API on 127.0.0.1:8081"
    (cd "$STATE" || exit; nohup node "$REPO/scripts/mock-telegram.mjs" serve 8081 1000001 \
      >mock-telegram.log 2>&1 &
      echo $! >mock-telegram.pid)
    wait_for 10 grep -q "Bot API" "$STATE/mock-telegram.log" || die "mock Telegram: $STATE/mock-telegram.log"
  fi
else
  TG_FILE=${DEMO_TELEGRAM_ENV_FILE:-$HOME/.mantle-aa/keys/meme-demo-telegram.env}
  tg() { [ -r "$TG_FILE" ] && sed -nE "s/^(export )?$1=[\"']?([^\"']*)[\"']?\$/\\2/p" "$TG_FILE" | tail -1; }
  MANTLE_MEME_TG_BOT_TOKEN=${MANTLE_MEME_TG_BOT_TOKEN:-$(tg MANTLE_MEME_TG_BOT_TOKEN)}
  MANTLE_MEME_TG_CHAT_ID=${MANTLE_MEME_TG_CHAT_ID:-$(tg MANTLE_MEME_TG_CHAT_ID)}
  [ -n "$MANTLE_MEME_TG_BOT_TOKEN" ] || die "no MANTLE_MEME_TG_BOT_TOKEN (env or $TG_FILE)"
  MANTLE_MEME_TG_API_URL=
fi
# OpenClaw admits DMs from this id only, and the autopilot pushes to it: your own user id.
[[ "${MANTLE_MEME_TG_CHAT_ID:-}" =~ ^[0-9]+$ ]] ||
  die "MANTLE_MEME_TG_CHAT_ID must be your numeric Telegram user id (your DM chat with the bot)"

# --- market-sim -----------------------------------------------------------------------------------
if running market-sim market-sim; then
  say "market-sim already running (pid $(cat "$STATE/market-sim.pid"))"
else
  if [ "${DEMO_FORK:-}" = 1 ]; then
    for a in $(MARKET_SIM_MNEMONIC_FILE=$MARKET_SIM_MNEMONIC_FILE node "$SIM" addresses | grep -oE '0x[0-9a-fA-F]{40}'); do
      cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x8ac7230489e80000 >/dev/null # 10 MNT
    done
  fi
  say "starting market-sim run $SIM_ARGS"
  # shellcheck disable=SC2086 # the options are words
  (cd "$STATE" || exit; MARKET_SIM_RPC_URL=$RPC MARKET_SIM_MNEMONIC_FILE=$MARKET_SIM_MNEMONIC_FILE \
    nohup node "$SIM" run $SIM_ARGS >market-sim.log 2>&1 &
    echo $! >market-sim.pid)
fi

# --- the OpenClaw container -------------------------------------------------------------------------
if [ -f "$STATE/container" ] && [ "$(docker inspect -f '{{.State.Running}}' "$(cat "$STATE/container")" 2>/dev/null)" = true ]; then
  say "container $CONTAINER already running"
else
  [ -z "$(docker ps -aq --filter "name=^/$CONTAINER\$")" ] ||
    die "a container named $CONTAINER exists that demo-up did not start; remove it or set DEMO_CONTAINER"
  say "building the image (cached after the first build; the first one takes a few minutes)"
  "${COMPOSE[@]}" build >"$STATE/build.log" 2>&1 || die "image build failed: $STATE/build.log"
  # The container gets the agent's environment only, whatever this shell holds for the root home.
  MANTLE_AA_KEYSTORE_PASSWORD=$(cat "$DEMO_AGENT_PASSWORD_FILE")
  MANTLE_AA_RPC_URL=$(dockerhost "$RPC")
  MANTLE_AA_SPONSOR_URL=http://host.docker.internal:$PORT
  # Where Telegram is reachable only through a proxy, the container uses this shell's (DEMO_PROXY=
  # turns it off): Node's fetch (the autopilot's push) and OpenClaw read these variables.
  PROXY=${DEMO_PROXY-${HTTPS_PROXY:-${https_proxy:-}}}
  HTTPS_PROXY=$(dockerhost "$PROXY") NODE_USE_ENV_PROXY=${PROXY:+1}
  NO_PROXY=${NO_PROXY:-${no_proxy:-localhost,127.0.0.1}},host.docker.internal
  MANTLE_MEME_CONTAINER=$CONTAINER MANTLE_MEME_GATEWAY=1
  MANTLE_MEME_AGENT_HOME=$AGENT_HOME MANTLE_MEME_OPENCLAW_STATE=$OC_STATE
  export MANTLE_AA_KEYSTORE_PASSWORD MANTLE_AA_RPC_URL MANTLE_AA_SPONSOR_URL MANTLE_MEME_CONTAINER \
    MANTLE_MEME_GATEWAY MANTLE_MEME_AGENT_HOME MANTLE_MEME_OPENCLAW_STATE MANTLE_MEME_TG_BOT_TOKEN \
    MANTLE_MEME_TG_CHAT_ID MANTLE_MEME_TG_API_URL HTTPS_PROXY NODE_USE_ENV_PROXY NO_PROXY
  [ -z "$PROXY" ] || say "the container reaches the internet through this shell's proxy (https_proxy)"
  say "starting container $CONTAINER (OpenClaw gateway with the Telegram channel, the launcher)"
  "${COMPOSE[@]}" up -d --no-build >>"$STATE/build.log" 2>&1 || die "container start failed: $STATE/build.log"
  docker inspect -f '{{.Id}}' "$CONTAINER" >"$STATE/container"
  unset MANTLE_AA_KEYSTORE_PASSWORD
fi
oc() { docker exec "$CONTAINER" node openclaw.mjs "$@"; }
wait_for 60 docker exec "$CONTAINER" test -S /tmp/mantle-meme-launcher.sock || die "the launcher is not up: docker logs $CONTAINER"
wait_for 120 sh -c "docker logs '$CONTAINER' 2>&1 | grep -q '\[gateway\] ready'" ||
  die "the OpenClaw gateway did not start: docker logs $CONTAINER"
# The skill, and the Telegram channel: DMs from the owner's id only, no groups, the token from the
# environment. The gateway applies it without a restart.
api=${MANTLE_MEME_TG_API_URL:+,\"apiRoot\":\"$MANTLE_MEME_TG_API_URL\"}
oc config set --batch-json "[{\"path\":\"skills.load.extraDirs\",\"value\":[\"/skills\"]},
  {\"path\":\"channels.telegram\",\"value\":{\"enabled\":true,\"dmPolicy\":\"allowlist\",
  \"allowFrom\":[\"\${MANTLE_MEME_TG_CHAT_ID}\"],\"groupPolicy\":\"disabled\"$api}}]" >/dev/null ||
  die "could not configure OpenClaw in $CONTAINER"
oc models status --check --plain >/dev/null 2>&1 ||
  [ $? = 2 ] || die "no usable model login in $OC_STATE (skills/mantle-meme/README.md, step 2)"
oc skills info mantle-meme 2>/dev/null | grep -qi ready ||
  die "the mantle-meme skill is not ready in $CONTAINER (oc skills info mantle-meme)"
wait_for 90 sh -c "docker logs '$CONTAINER' 2>&1 | grep -q 'starting provider (@'" ||
  die "the Telegram channel did not start: docker logs $CONTAINER | grep -i telegram"
bot=$(docker logs "$CONTAINER" 2>&1 | grep -o 'starting provider (@[^)]*)' | tail -1)
say "up: sponsor, market-sim and $CONTAINER; Telegram bot ${bot#starting provider }"
say "logs: $STATE/*.log, docker logs $CONTAINER. Stop everything: scripts/demo-down.sh"
