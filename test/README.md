# Ride-service smoke test

This folder contains a simple “smoke test” script that produces a minimal event flow into Kafka and waits for the `ride-service` to respond.

## Prerequisites

- Kafka running (default broker: `localhost:29092`)
- `ride-service` running (it must be consuming `driver.events`, `ride.events`, `gps.stream`)

If Kafka was just started, give it ~10–30 seconds to finish leader election (the test also waits, but startup can be slow on first boot).

Start ride-service (in another terminal):

`cmd /c npm run start:ride-service`

## Run

From repo root:

`cmd /c npx tsc -p test/tsconfig.json`

`cmd /c node test/dist/ride-service.smoke.js`

Optional:

- Set brokers: `set KAFKA_BROKERS=localhost:29092` (Windows `cmd`)

## Note (Docker Compose)

In this repo’s `infra/docker-compose.yml`, Kafka is configured with a host listener on `localhost:29092`.
Use `KAFKA_BROKERS=localhost:29092` when running tests/services on your host machine.
