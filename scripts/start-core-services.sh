#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cd "$ROOT_DIR"

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

npm run build

npm run start:payment-service &
PAYMENT_PID=$!

npm run start:ride-service &
RIDE_PID=$!

npm run start:api-gateway &
GATEWAY_PID=$!

wait
