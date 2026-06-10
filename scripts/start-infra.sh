#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "Docker Compose is not installed." >&2
    exit 1
  fi
}

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

cd "$ROOT_DIR/infra"

if [ -f "$ROOT_DIR/.env.compose" ]; then
  docker_compose --env-file "$ROOT_DIR/.env.compose" up -d postgres redis zookeeper kafka
else
  docker_compose up -d postgres redis zookeeper kafka
fi

wait_for_tcp_port localhost 5432 60 "Postgres"
wait_for_tcp_port localhost 6379 60 "Redis"
wait_for_tcp_port localhost 29092 90 "Kafka"
