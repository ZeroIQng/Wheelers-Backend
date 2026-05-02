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

wait_for_running_service() {
  service_name=$1
  timeout_seconds=$2
  elapsed=0

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    if docker_compose ps --services --status running 2>/dev/null | grep -Fx "$service_name" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "Timed out waiting for container \"$service_name\" to be running." >&2
  return 1
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

docker_compose up -d

if ! wait_for_running_service kafka 20; then
  echo "Kafka did not stay up after initial start. Restarting zookeeper and kafka once..." >&2
  docker_compose rm -sf kafka zookeeper >/dev/null 2>&1 || true
  docker_compose up -d zookeeper kafka
fi

wait_for_running_service zookeeper 20
wait_for_running_service kafka 30
wait_for_tcp_port localhost 29092 60 "Kafka"
wait_for_tcp_port localhost 5432 30 "Postgres"
wait_for_tcp_port localhost 6379 30 "Redis"
