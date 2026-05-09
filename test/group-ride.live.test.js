const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GoogleMapsRoutePlanner,
  loadWorkspaceEnv,
} = require('../packages/config/dist/index.js');
const {
  buildGroupRoute,
} = require('../apps/group-ride/dist/planner/route-builder.js');

loadWorkspaceEnv();

const apiKey = process.env.GOOGLE_MAPS_API_KEY;

if (!apiKey) {
  test.skip('live google routes integration requires GOOGLE_MAPS_API_KEY', () => {});
} else {
  test('live google routes integration builds a real grouped route', async () => {
    const routePlanner = new GoogleMapsRoutePlanner(
      process.env.GOOGLE_MAPS_BASE_URL || 'https://routes.googleapis.com',
      apiKey,
    );

    const stops = [
      {
        rideId: '81818181-8181-8181-8181-818181818181',
        riderId: '91919191-9191-9191-9191-919191919191',
        sequence: 0,
        kind: 'pickup',
        lat: 6.4281,
        lng: 3.4219,
        address: 'Eko Hotel & Suites, Adetokunbo Ademola Street, Victoria Island, Lagos',
      },
      {
        rideId: '82828282-8282-8282-8282-828282828282',
        riderId: '92929292-9292-9292-9292-929292929292',
        sequence: 1,
        kind: 'pickup',
        lat: 6.4313,
        lng: 3.4308,
        address: 'Civic Centre, Ozumba Mbadiwe Avenue, Victoria Island, Lagos',
      },
      {
        rideId: '81818181-8181-8181-8181-818181818181',
        riderId: '91919191-9191-9191-9191-919191919191',
        sequence: 2,
        kind: 'dropoff',
        lat: 6.4265,
        lng: 3.442,
        address: 'Landmark Centre, Water Corporation Drive, Victoria Island, Lagos',
      },
      {
        rideId: '82828282-8282-8282-8282-828282828282',
        riderId: '92929292-9292-9292-9292-929292929292',
        sequence: 3,
        kind: 'dropoff',
        lat: 6.4356,
        lng: 3.4445,
        address: 'The Palms Shopping Mall, Lekki Road, Victoria Island, Lagos',
      },
    ];

    const builtRoute = await buildGroupRoute({
      routePlanner,
      stops,
    });

    assert.equal(builtRoute.legs.length, stops.length - 1);
    assert.ok(builtRoute.totalDistanceKm > 0);
    assert.ok(builtRoute.totalDurationSeconds > 0);
    assert.ok(builtRoute.route.coordinates.length >= stops.length);
  });
}
