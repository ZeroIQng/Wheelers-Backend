# Group Ride

This workspace implements a practical group-ride pipeline for Wheleers:

1. Consume `RIDE_REQUESTED`
2. Score nearby riders with KNN-style proximity + direction filtering
3. Build a compatible group
4. Solve pickup/dropoff order with a precedence-constrained stop sequencer
5. Build road routes for each stop-to-stop leg
6. Emit stage results to `group-ride.events`

## Algorithms

- Matching: `src/algorithms/knn.ts`
  Uses pickup radius, destination radius, and bearing delta to identify riders
  following a similar corridor.
- Group formation: `src/algorithms/grouping.ts`
  Starts from an anchor rider and adds only pairwise-compatible members.
- Stop order: `src/algorithms/stop-sequencer.ts`
  Uses dynamic programming for small groups so dropoffs never occur before
  pickups. Falls back to greedy nearest-neighbour for larger graphs.
- Road routing: `src/planner/route-builder.ts`
  Uses the shared Google Routes planner to construct the real path for each leg.
- Offline path experiments: `src/algorithms/graph-search.ts`
  Includes generic A* and Dijkstra helpers for local graph experiments.

## Kafka stages

- `GROUP_RIDE_CANDIDATES_IDENTIFIED`
- `GROUP_RIDE_PLANNED`
- `GROUP_RIDE_ROUTE_BUILT`

This keeps matching, grouping, and routing separable even though they currently
run in one workspace.
