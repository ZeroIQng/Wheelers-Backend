#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cd "$ROOT_DIR"

wait_for_tcp_port() {
  host=$1
  port=$2
  timeout_seconds=$3
  label=$4
  elapsed=0

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    if node -e "const net = require('node:net'); const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) }); socket.on('connect', () => { socket.end(); process.exit(0); }); socket.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 1000);" "$host" "$port" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "Timed out waiting for $label at $host:$port." >&2
  return 1
}

cleanup() {
  if [ "${PAYMENT_PID:-}" != "" ]; then
    kill "$PAYMENT_PID" 2>/dev/null || true
  fi

  if [ "${RIDE_PID:-}" != "" ]; then
    kill "$RIDE_PID" 2>/dev/null || true
  fi

  if [ "${GATEWAY_PID:-}" != "" ]; then
    kill "$GATEWAY_PID" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
}

trap cleanup INT TERM EXIT

export KAFKAJS_NO_PARTITIONER_WARNING=1

wait_for_tcp_port localhost 29092 60 "Kafka"
wait_for_tcp_port localhost 5432 30 "Postgres"
wait_for_tcp_port localhost 6379 30 "Redis"

npm run build

npm run start:payment-service &
PAYMENT_PID=$!

npm run start:ride-service &
RIDE_PID=$!

npm run start:api-gateway &
GATEWAY_PID=$!

wait
