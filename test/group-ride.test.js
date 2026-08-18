const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreRideCompatibility,
  findNearestRouteCandidates,
} = require('../apps/group-ride/dist/algorithms/knn.js');
const {
  buildNearestRouteGroup,
} = require('../apps/group-ride/dist/algorithms/grouping.js');
const {
  planGroupStops, 
} = require('../apps/group-ride/dist/algorithms/stop-sequencer.js');
const {
  createGroupRidePlanner,
} = require('../apps/group-ride/dist/planner/group-ride.planner.js');
const {
  createGroupRideState,
} = require('../apps/group-ride/dist/state.js');

const ENV = {
  GOOGLE_MAPS_API_KEY: 'test-key',
  GOOGLE_MAPS_BASE_URL: 'https://routes.googleapis.com',
  GROUP_RIDE_PICKUP_RADIUS_KM: 2.5,
  GROUP_RIDE_DESTINATION_RADIUS_KM: 6,
  GROUP_RIDE_BEARING_THRESHOLD_DEG: 35,
  GROUP_RIDE_MAX_CANDIDATES: 6,
  GROUP_RIDE_MAX_SIZE: 3,
  GROUP_RIDE_REQUEST_TTL_S: 600,
};

test('compatibility scoring accepts same-corridor rides and rejects heading mismatch', () => {
  const anchor = makeRequest({
    rideId: '11111111-1111-1111-1111-111111111111',
    riderId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    pickup: point(37.7749, -122.4194, 'Anchor pickup'),
    destination: point(37.7849, -122.3394, 'Anchor destination'),
    headingDeg: 90,
  });
  const aligned = makeRequest({
    rideId: '22222222-2222-2222-2222-222222222222',
    riderId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    pickup: point(37.7799, -122.4164, 'Aligned pickup'),
    destination: point(37.7899, -122.3364, 'Aligned destination'),
    headingDeg: 96,
  });
  const oppositeDirection = makeRequest({
    rideId: '33333333-3333-3333-3333-333333333333',
    riderId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    pickup: point(37.7799, -122.4164, 'Opposite pickup'),
    destination: point(37.7899, -122.3364, 'Opposite destination'),
    headingDeg: 220,
  });

  const candidate = scoreRideCompatibility(anchor, aligned, ENV);
  assert.ok(candidate, 'expected nearby aligned ride to be compatible');
  assert.ok(candidate.score > 0.8);
  assert.equal(scoreRideCompatibility(anchor, oppositeDirection, ENV), null);
});

test('group builder skips riders that are not pairwise compatible with the accepted group', () => {
  const anchor = makeRequest({
    rideId: '44444444-4444-4444-4444-444444444444',
    riderId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    pickup: point(37.7749, -122.4194, 'Anchor pickup'),
    destination: point(37.7849, -122.3394, 'Anchor destination'),
    headingDeg: 90,
  });
  const north = makeRequest({
    rideId: '55555555-5555-5555-5555-555555555555',
    riderId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    pickup: point(37.7869, -122.4194, 'North pickup'),
    destination: point(37.8149, -122.3394, 'North destination'),
    headingDeg: 90,
  });
  const south = makeRequest({
    rideId: '66666666-6666-6666-6666-666666666666',
    riderId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    pickup: point(37.7629, -122.4194, 'South pickup'),
    destination: point(37.7549, -122.3394, 'South destination'),
    headingDeg: 90,
  });
  const center = makeRequest({
    rideId: '77777777-7777-7777-7777-777777777777',
    riderId: '12121212-1212-1212-1212-121212121212',
    pickup: point(37.7769, -122.4184, 'Center pickup'),
    destination: point(37.7869, -122.3384, 'Center destination'),
    headingDeg: 91,
  });

  const group = buildNearestRouteGroup({
    anchor,
    candidates: [
      scoreRideCompatibility(anchor, north, ENV),
      scoreRideCompatibility(anchor, south, ENV),
      scoreRideCompatibility(anchor, center, ENV),
    ].filter(Boolean),
    env: ENV,
  });

  assert.deepEqual(
    group.map((member) => member.rideId),
    [
      anchor.rideId,
      north.rideId,
      center.rideId,
    ],
  );
  assert.ok(!group.some((member) => member.rideId === south.rideId));
});

test('stop sequencing keeps every pickup before its dropoff', () => {
  const members = [
    makeRequest({
      rideId: '88888888-8888-8888-8888-888888888888',
      riderId: '13131313-1313-1313-1313-131313131313',
      pickup: point(37.7749, -122.4194, 'A pickup'),
      destination: point(37.7849, -122.3394, 'A destination'),
      headingDeg: 90,
    }),
    makeRequest({
      rideId: '99999999-9999-9999-9999-999999999999',
      riderId: '14141414-1414-1414-1414-141414141414',
      pickup: point(37.7769, -122.4174, 'B pickup'),
      destination: point(37.7869, -122.3374, 'B destination'),
      headingDeg: 91,
    }),
    makeRequest({
      rideId: 'aaaaaaaa-1111-1111-1111-111111111111',
      riderId: '15151515-1515-1515-1515-151515151515',
      pickup: point(37.7789, -122.4154, 'C pickup'),
      destination: point(37.7889, -122.3354, 'C destination'),
      headingDeg: 92,
    }),
  ];

  const sequence = planGroupStops({
    anchorRideId: members[0].rideId,
    members,
  });

  assert.equal(sequence.algorithm, 'dp_precedence');
  assert.equal(sequence.stops[0].rideId, members[0].rideId);

  for (const member of members) {
    const pickupIndex = sequence.stops.findIndex(
      (stop) => stop.rideId === member.rideId && stop.kind === 'pickup',
    );
    const dropoffIndex = sequence.stops.findIndex(
      (stop) => stop.rideId === member.rideId && stop.kind === 'dropoff',
    );
    assert.ok(pickupIndex >= 0, `missing pickup for ${member.rideId}`);
    assert.ok(dropoffIndex >= 0, `missing dropoff for ${member.rideId}`);
    assert.ok(
      pickupIndex < dropoffIndex,
      `pickup should precede dropoff for ${member.rideId}`,
    );
  }
});

test('large groups fall back to greedy sequencing and still preserve pickup precedence', () => {
  const members = Array.from({ length: 7 }, (_, index) =>
    makeRequest({
      rideId: makeUuid(`20202020${index}`),
      riderId: makeUuid(`30303030${index}`),
      pickup: point(
        37.7749 + index * 0.0015,
        -122.4194 + index * 0.0015,
        `Pickup ${index + 1}`,
      ),
      destination: point(
        37.8049 + index * 0.0015,
        -122.3894 + index * 0.0015,
        `Destination ${index + 1}`,
      ),
      headingDeg: 90,
    }),
  );

  const sequence = planGroupStops({
    anchorRideId: members[0].rideId,
    members,
  });

  assert.equal(sequence.algorithm, 'greedy_nearest_neighbour');
  assert.equal(sequence.stops.length, members.length * 2);

  for (const member of members) {
    assertPickupDropoffOrder(sequence.stops, member.rideId);
  }
});

test('dense overlapping pools cap candidate search and group size around the anchor', () => {
  const anchor = makeRequest({
    rideId: '21212121-2121-2121-2121-212121212121',
    riderId: '31313131-3131-3131-3131-313131313131',
    pickup: point(37.7749, -122.4194, 'Anchor pickup'),
    destination: point(37.8049, -122.3894, 'Anchor destination'),
    headingDeg: 90,
  });
  const pool = [anchor];

  for (let index = 1; index <= 10; index += 1) {
    pool.push(
      makeRequest({
        rideId: makeUuid(`41414141${index}`),
        riderId: makeUuid(`51515151${index}`),
        pickup: point(
          37.7749 + index * 0.001,
          -122.4194 + index * 0.001,
          `Candidate pickup ${index}`,
        ),
        destination: point(
          37.8049 + index * 0.001,
          -122.3894 + index * 0.001,
          `Candidate destination ${index}`,
        ),
        headingDeg: 90 + index * 0.5,
      }),
    );
  }

  const candidates = findNearestRouteCandidates(anchor, pool, ENV);
  const group = buildNearestRouteGroup({
    anchor,
    candidates,
    env: ENV,
  });

  assert.equal(candidates.length, ENV.GROUP_RIDE_MAX_CANDIDATES);
  assert.equal(group.length, ENV.GROUP_RIDE_MAX_SIZE);
  assert.deepEqual(
    group.map((member) => member.rideId),
    [anchor.rideId, candidates[0].request.rideId, candidates[1].request.rideId],
  );
});

test('planner prunes expired requests before matching', async () => {
  const producer = createCapturedProducer();
  const state = createGroupRideState();
  const planner = createGroupRidePlanner({
    env: ENV,
    routePlanner: createStubRoutePlanner(),
    groupRideEventsProducer: producer.api,
    state,
  });

  const expiredRequest = makeRequest({
    rideId: 'abababab-abab-abab-abab-abababababab',
    riderId: '16161616-1616-1616-1616-161616161616',
    pickup: point(37.7749, -122.4194, 'Expired pickup'),
    destination: point(37.7849, -122.3394, 'Expired destination'),
    headingDeg: 90,
    requestedAt: new Date(Date.now() - (ENV.GROUP_RIDE_REQUEST_TTL_S + 30) * 1000).toISOString(),
  });
  state.pendingRequestsByRideId.set(expiredRequest.rideId, expiredRequest);

  await planner.handleRideReadyForMatch(
    makeReadyForMatchEvent({
      rideId: 'bcbcbcbc-bcbc-bcbc-bcbc-bcbcbcbcbcbc',
      riderId: '17171717-1717-1717-1717-171717171717',
      pickup: point(37.7769, -122.4174, 'Fresh pickup'),
      destination: point(37.7869, -122.3374, 'Fresh destination'),
      fareEstimateNgn: 12,
    }),
  );

  assert.equal(producer.candidates.length, 0);
  assert.equal(state.pendingRequestsByRideId.has(expiredRequest.rideId), false);
});

test('planner emits candidate, planned, and built route events for a compatible pair', async () => {
  const producer = createCapturedProducer();
  const routePlanner = createStubRoutePlanner();
  const planner = createGroupRidePlanner({
    env: ENV,
    routePlanner,
    groupRideEventsProducer: producer.api,
    state: createGroupRideState(),
  });

  const rideA = makeReadyForMatchEvent({
    rideId: 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd',
    riderId: '18181818-1818-1818-1818-181818181818',
    pickup: point(37.7749, -122.4194, 'Ride A pickup'),
    destination: point(37.7849, -122.3394, 'Ride A destination'),
    fareEstimateNgn: 10,
  });
  const rideB = makeReadyForMatchEvent({
    rideId: 'dededede-dede-dede-dede-dededededede',
    riderId: '19191919-1919-1919-1919-191919191919',
    pickup: point(37.7769, -122.4174, 'Ride B pickup'),
    destination: point(37.7869, -122.3374, 'Ride B destination'),
    fareEstimateNgn: 11,
  });

  await planner.handleRideReadyForMatch(rideA);
  assert.equal(producer.candidates.length, 0);

  await planner.handleRideReadyForMatch(rideB);
  assert.equal(producer.candidates.length, 1);

  const candidateEvent = producer.candidates[0];
  assert.deepEqual(
    candidateEvent.rideIds.slice().sort(),
    [rideA.rideId, rideB.rideId].sort(),
  );

  await planner.handleGroupRideEvent(candidateEvent);
  assert.equal(producer.planned.length, 1);

  const plannedEvent = producer.planned[0];
  assert.equal(plannedEvent.sequenceAlgorithm, 'dp_precedence');
  assert.equal(plannedEvent.stops.length, 4);
  assertPickupDropoffOrder(plannedEvent.stops, rideA.rideId);
  assertPickupDropoffOrder(plannedEvent.stops, rideB.rideId);

  await planner.handleGroupRideEvent(plannedEvent);
  assert.equal(producer.routes.length, 1);

  const builtEvent = producer.routes[0];
  assert.equal(builtEvent.legs.length, plannedEvent.stops.length - 1);
  assert.ok(builtEvent.totalDistanceKm > 0);
  assert.ok(builtEvent.totalDurationSeconds > 0);
});

test('planner does not assign the same ride twice under heavy overlap', async () => {
  const producer = createCapturedProducer();
  const planner = createGroupRidePlanner({
    env: ENV,
    routePlanner: createStubRoutePlanner(),
    groupRideEventsProducer: producer.api,
    state: createGroupRideState(),
  });

  for (let index = 0; index < 8; index += 1) {
    await planner.handleRideReadyForMatch(
      makeReadyForMatchEvent({
        rideId: makeUuid(`61616161${index}`),
        riderId: makeUuid(`71717171${index}`),
        pickup: point(
          37.7749 + index * 0.0012,
          -122.4194 + index * 0.0012,
          `Stress pickup ${index + 1}`,
        ),
        destination: point(
          37.8049 + index * 0.0012,
          -122.3894 + index * 0.0012,
          `Stress destination ${index + 1}`,
        ),
        fareEstimateNgn: 10 + index,
      }),
    );
  }

  assert.ok(producer.candidates.length >= 3);

  for (const candidateEvent of [...producer.candidates]) {
    await planner.handleGroupRideEvent(candidateEvent);
  }

  for (const plannedEvent of [...producer.planned]) {
    await planner.handleGroupRideEvent(plannedEvent);
  }

  const assignedRideIds = producer.planned.flatMap((event) => event.rideIds);
  const uniqueAssignedRideIds = new Set(assignedRideIds);

  assert.equal(assignedRideIds.length, uniqueAssignedRideIds.size);
  assert.ok(producer.planned.length >= 2);
  assert.equal(producer.routes.length, producer.planned.length);

  for (const routeEvent of producer.routes) {
    assert.ok(routeEvent.rideIds.length <= ENV.GROUP_RIDE_MAX_SIZE);
  }
});

test('planner recovers after candidate emission failure and can emit on retry', async () => {
  const producer = createCapturedProducer({
    failCandidatesTimes: 1,
  });
  const planner = createGroupRidePlanner({
    env: ENV,
    routePlanner: createStubRoutePlanner(),
    groupRideEventsProducer: producer.api,
    state: createGroupRideState(),
  });

  const rideA = makeReadyForMatchEvent({
    rideId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
    riderId: 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1',
    pickup: point(37.7749, -122.4194, 'Retry A pickup'),
    destination: point(37.7849, -122.3394, 'Retry A destination'),
    fareEstimateNgn: 10,
  });
  const rideB = makeReadyForMatchEvent({
    rideId: 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1',
    riderId: 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
    pickup: point(37.7769, -122.4174, 'Retry B pickup'),
    destination: point(37.7869, -122.3374, 'Retry B destination'),
    fareEstimateNgn: 11,
  });

  await planner.handleRideReadyForMatch(rideA);
  await assert.rejects(() => planner.handleRideReadyForMatch(rideB), /candidate emit failed/);
  assert.equal(producer.candidates.length, 0);

  await planner.handleRideReadyForMatch(rideB);
  assert.equal(producer.candidates.length, 1);
});

test('planner retries group planning safely after group planned emission failure', async () => {
  const producer = createCapturedProducer({
    failPlannedTimes: 1,
  });
  const planner = createGroupRidePlanner({
    env: ENV,
    routePlanner: createStubRoutePlanner(),
    groupRideEventsProducer: producer.api,
    state: createGroupRideState(),
  });

  const rideA = makeReadyForMatchEvent({
    rideId: 'e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1',
    riderId: 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1',
    pickup: point(37.7749, -122.4194, 'Plan retry A pickup'),
    destination: point(37.7849, -122.3394, 'Plan retry A destination'),
    fareEstimateNgn: 10,
  });
  const rideB = makeReadyForMatchEvent({
    rideId: '11111111-2222-3333-4444-555555555555',
    riderId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
    pickup: point(37.7769, -122.4174, 'Plan retry B pickup'),
    destination: point(37.7869, -122.3374, 'Plan retry B destination'),
    fareEstimateNgn: 11,
  });

  await planner.handleRideReadyForMatch(rideA);
  await planner.handleRideReadyForMatch(rideB);

  const candidateEvent = producer.candidates[0];
  await assert.rejects(
    () => planner.handleGroupRideEvent(candidateEvent),
    /group planned emit failed/,
  );
  assert.equal(producer.planned.length, 0);

  await planner.handleGroupRideEvent(candidateEvent);
  assert.equal(producer.planned.length, 1);
  assert.deepEqual(
    producer.planned[0].rideIds.slice().sort(),
    [rideA.rideId, rideB.rideId].sort(),
  );
});

test('noisy corridor simulation sustains grouping while isolating far outliers', async () => {
  const producer = createCapturedProducer();
  const planner = createGroupRidePlanner({
    env: ENV,
    routePlanner: createStubRoutePlanner(),
    groupRideEventsProducer: producer.api,
    state: createGroupRideState(),
  });

  const requests = buildNoisyScenarioRequests();
  for (const request of requests) {
    await planner.handleRideReadyForMatch(request);
  }

  for (const candidateEvent of [...producer.candidates]) {
    await planner.handleGroupRideEvent(candidateEvent);
  }

  const groupedRideIds = new Set(
    producer.planned.flatMap((event) => event.rideIds),
  );
  const outlierRideIds = new Set(
    requests
      .filter((request) => request.pickup.address.startsWith('Outlier'))
      .map((request) => request.rideId),
  );

  assert.ok(producer.planned.length >= 4);
  assert.ok(groupedRideIds.size >= 10);
  for (const outlierRideId of outlierRideIds) {
    assert.equal(groupedRideIds.has(outlierRideId), false);
  }
});

test('load simulation processes hundreds of requests within a practical bound', async () => {
  const producer = createCapturedProducer();
  const planner = createGroupRidePlanner({
    env: ENV,
    routePlanner: createStubRoutePlanner(),
    groupRideEventsProducer: producer.api,
    state: createGroupRideState(),
  });

  const requests = buildLoadScenarioRequests(360);
  const startedAt = process.hrtime.bigint();

  for (const request of requests) {
    await planner.handleRideReadyForMatch(request);
  }

  for (const candidateEvent of [...producer.candidates]) {
    await planner.handleGroupRideEvent(candidateEvent);
  }

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const assignedRideIds = new Set(
    producer.planned.flatMap((event) => event.rideIds),
  );

  assert.ok(producer.candidates.length >= 60);
  assert.ok(producer.planned.length >= 60);
  assert.ok(assignedRideIds.size >= 180);
  assert.ok(
    elapsedMs < 2500,
    `expected load simulation to finish under 2500ms, got ${elapsedMs.toFixed(2)}ms`,
  );
});

function createCapturedProducer(options = {}) {
  const captured = {
    candidates: [],
    planned: [],
    routes: [],
  };
  let remainingCandidateFailures = options.failCandidatesTimes ?? 0;
  let remainingPlannedFailures = options.failPlannedTimes ?? 0;
  let remainingRouteFailures = options.failRoutesTimes ?? 0;

  return {
    ...captured,
    api: {
      async candidatesIdentified(event) {
        if (remainingCandidateFailures > 0) {
          remainingCandidateFailures -= 1;
          throw new Error('candidate emit failed');
        }
        captured.candidates.push(event);
      },
      async groupPlanned(event) {
        if (remainingPlannedFailures > 0) {
          remainingPlannedFailures -= 1;
          throw new Error('group planned emit failed');
        }
        captured.planned.push(event);
      },
      async routeBuilt(event) {
        if (remainingRouteFailures > 0) {
          remainingRouteFailures -= 1;
          throw new Error('route built emit failed');
        }
        captured.routes.push(event);
      },
    },
  };
}

function createStubRoutePlanner() {
  return {
    async planRoute({ origin, destination }) {
      const distanceKm = Math.sqrt(
        (origin.lat - destination.lat) ** 2 +
          (origin.lng - destination.lng) ** 2,
      ) * 111;
      return {
        distanceKm,
        durationSeconds: Math.max(60, Math.round(distanceKm * 120)),
        geometry: {
          coordinates: [
            { lat: origin.lat, lng: origin.lng },
            { lat: destination.lat, lng: destination.lng },
          ],
          bounds: {
            northEast: {
              lat: Math.max(origin.lat, destination.lat),
              lng: Math.max(origin.lng, destination.lng),
            },
            southWest: {
              lat: Math.min(origin.lat, destination.lat),
              lng: Math.min(origin.lng, destination.lng),
            },
          },
        },
      };
    },
  };
}

function makeRequest({
  rideId,
  riderId,
  pickup,
  destination,
  headingDeg,
  fareEstimateNgn = 10,
  requestedAt = new Date().toISOString(),
}) {
  return {
    rideId,
    riderId,
    pickup,
    destination,
    headingDeg,
    fareEstimateNgn,
    requestedAt,
    sourceEvent: makeReadyForMatchEvent({
      rideId,
      riderId,
      pickup,
      destination,
      fareEstimateNgn,
      timestamp: requestedAt,
    }),
  };
}

function makeReadyForMatchEvent({
  rideId,
  riderId,
  pickup,
  destination,
  fareEstimateNgn,
  timestamp = new Date().toISOString(),
}) {
  return {
    eventType: 'GROUP_RIDE_READY_FOR_MATCH',
    rideId,
    riderId,
    faceVerificationId: '00000000-0000-0000-0000-000000000000',
    pickup,
    destination,
    stops: [],
    fareEstimateNgn,
    genderPreference: 'any',
    paymentMethod: 'wallet_balance',
    timestamp,
  };
}

function point(lat, lng, address) {
  return { lat, lng, address };
}

function makeUuid(seed) {
  const normalized = seed.toLowerCase().replace(/[^a-f0-9]/g, '').padEnd(32, '0').slice(0, 32);
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`;
}

function buildNoisyScenarioRequests() {
  const requests = [];
  let seed = 7;

  for (let corridor = 0; corridor < 4; corridor += 1) {
    const basePickupLat = 37.72 + corridor * 0.03;
    const basePickupLng = -122.48 + corridor * 0.015;
    const baseDestinationLat = basePickupLat + 0.045;
    const baseDestinationLng = basePickupLng + 0.045;

    for (let index = 0; index < 4; index += 1) {
      const pickupLat = basePickupLat + jitter(seed) * 0.004;
      seed += 1;
      const pickupLng = basePickupLng + jitter(seed) * 0.004;
      seed += 1;
      const destinationLat = baseDestinationLat + jitter(seed) * 0.004;
      seed += 1;
      const destinationLng = baseDestinationLng + jitter(seed) * 0.004;
      seed += 1;

      requests.push(
        makeReadyForMatchEvent({
          rideId: makeUuid(`noise-c${corridor}-r${index}`),
          riderId: makeUuid(`noise-rider-c${corridor}-r${index}`),
          pickup: point(pickupLat, pickupLng, `Corridor ${corridor} pickup ${index}`),
          destination: point(
            destinationLat,
            destinationLng,
            `Corridor ${corridor} destination ${index}`,
          ),
          fareEstimateNgn: 10 + corridor + index,
        }),
      );
    }
  }

  for (let index = 0; index < 4; index += 1) {
    requests.push(
      makeReadyForMatchEvent({
        rideId: makeUuid(`outlier-r${index}`),
        riderId: makeUuid(`outlier-rider-${index}`),
        pickup: point(37.55 + index * 0.09, -122.8 + index * 0.04, `Outlier pickup ${index}`),
        destination: point(37.95 - index * 0.07, -121.9 + index * 0.05, `Outlier destination ${index}`),
        fareEstimateNgn: 18 + index,
      }),
    );
  }

  return requests;
}

function buildLoadScenarioRequests(totalRequests) {
  const requests = [];
  let globalIndex = 0;

  for (let corridor = 0; corridor < 12 && globalIndex < totalRequests; corridor += 1) {
    const basePickupLat = 37.65 + corridor * 0.01;
    const basePickupLng = -122.52 + corridor * 0.006;
    const baseDestinationLat = basePickupLat + 0.03;
    const baseDestinationLng = basePickupLng + 0.03;

    for (let batch = 0; batch < 10 && globalIndex < totalRequests; batch += 1) {
      for (let seat = 0; seat < 3 && globalIndex < totalRequests; seat += 1) {
        requests.push(
          makeReadyForMatchEvent({
            rideId: makeUuid(`load-${corridor}-${batch}-${seat}`),
            riderId: makeUuid(`load-rider-${corridor}-${batch}-${seat}`),
            pickup: point(
              basePickupLat + seat * 0.0015 + batch * 0.00005,
              basePickupLng + seat * 0.0015 + batch * 0.00005,
              `Load pickup ${corridor}-${batch}-${seat}`,
            ),
            destination: point(
              baseDestinationLat + seat * 0.0015 + batch * 0.00005,
              baseDestinationLng + seat * 0.0015 + batch * 0.00005,
              `Load destination ${corridor}-${batch}-${seat}`,
            ),
            fareEstimateNgn: 10 + corridor + seat,
          }),
        );
        globalIndex += 1;
      }
    }
  }

  return requests;
}

function jitter(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

function assertPickupDropoffOrder(stops, rideId) {
  const pickupIndex = stops.findIndex(
    (stop) => stop.rideId === rideId && stop.kind === 'pickup',
  );
  const dropoffIndex = stops.findIndex(
    (stop) => stop.rideId === rideId && stop.kind === 'dropoff',
  );

  assert.ok(pickupIndex >= 0, `missing pickup for ${rideId}`);
  assert.ok(dropoffIndex >= 0, `missing dropoff for ${rideId}`);
  assert.ok(pickupIndex < dropoffIndex, `pickup should precede dropoff for ${rideId}`);
}
