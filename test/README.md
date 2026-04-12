# Ride-service smoke test

This folder contains a simple smoke test script that produces a minimal event flow into Kafka and waits for the `ride-service` to respond.

The flow covers:

- two drivers going online
- a rider request producing a ride offer notification
- first driver rejection causing retry to the next driver
- simulated driver acceptance through `RIDE_DRIVER_ASSIGNED`
- one GPS ping producing `GPS_PROCESSED`

## Prerequisites

- Kafka running (default broker: `localhost:29092`)
- Postgres running (default database: `postgresql://postgres:postgres@localhost:5432/wheelers`) with migrations applied
- `ride-service` running (it must be consuming `driver.events`, `ride.events`, `gps.stream`)
- Kafka topics for `driver.events`, `ride.events`, `gps.stream`, `gps.processed`, `compliance.events`, and `notification.events`

If Kafka was just started, give it ~10–30 seconds to finish leader election (the test also waits, but startup can be slow on first boot).

Start ride-service (in another terminal):

`cmd /c npm run start:ride-service`

## Run

From repo root:

`cmd /c npm run test:ride-service`

For the wallet/payment persistence integration test:

`cmd /c npm run test:wallet-payment-integration`

Optional:

- Set brokers: `set KAFKA_BROKERS=localhost:29092` (Windows `cmd`)

## Note (Docker Compose)

In this repo’s `infra/docker-compose.yml`, Kafka is configured with a host listener on `localhost:29092`.
Use `KAFKA_BROKERS=localhost:29092` when running tests/services on your host machine.

The wallet/payment integration test only needs Postgres with migrations applied.
