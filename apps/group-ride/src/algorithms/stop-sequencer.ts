import { haversineKm, round3 } from './geo';
import type { GroupRideRequest, PlannedGroupStop } from '../types';

type StopNode = {
  rideId: string;
  riderId: string;
  lat: number;
  lng: number;
  address: string;
  kind: 'pickup' | 'dropoff';
  pairedPickupIndex: number;
};

type SequenceResult = {
  stops: PlannedGroupStop[];
  heuristicDistanceKm: number;
  algorithm: 'dp_precedence' | 'greedy_nearest_neighbour';
};

export function planGroupStops(params: {
  anchorRideId: string;
  members: GroupRideRequest[];
}): SequenceResult {
  const nodes = buildNodes(params.members);
  const anchorPickupIndex = nodes.findIndex(
    (node) => node.rideId === params.anchorRideId && node.kind === 'pickup',
  );
  if (anchorPickupIndex < 0) {
    throw new Error(`Anchor ride ${params.anchorRideId} is missing from group`);
  }

  if (nodes.length > 12) {
    return greedyNearestNeighbour(nodes, anchorPickupIndex);
  }

  const visitedMask = 1 << anchorPickupIndex;
  const exact = solveExact(nodes, anchorPickupIndex, visitedMask);

  const orderedNodeIndices = [anchorPickupIndex, ...exact.path];
  const stops = orderedNodeIndices.map((nodeIndex, sequence) =>
    nodeToStop(nodes[nodeIndex], sequence),
  );

  return {
    stops,
    heuristicDistanceKm: round3(exact.cost),
    algorithm: 'dp_precedence',
  };
}

function buildNodes(members: GroupRideRequest[]): StopNode[] {
  const nodes: StopNode[] = [];

  for (const member of members) {
    const pickupIndex = nodes.length;
    nodes.push({
      rideId: member.rideId,
      riderId: member.riderId,
      lat: member.pickup.lat,
      lng: member.pickup.lng,
      address: member.pickup.address,
      kind: 'pickup',
      pairedPickupIndex: pickupIndex,
    });
    nodes.push({
      rideId: member.rideId,
      riderId: member.riderId,
      lat: member.destination.lat,
      lng: member.destination.lng,
      address: member.destination.address,
      kind: 'dropoff',
      pairedPickupIndex: pickupIndex,
    });
  }

  return nodes;
}

function solveExact(
  nodes: StopNode[],
  currentIndex: number,
  visitedMask: number,
  memo = new Map<string, { cost: number; path: number[] }>(),
): { cost: number; path: number[] } {
  const allVisitedMask = (1 << nodes.length) - 1;
  if (visitedMask === allVisitedMask) {
    return { cost: 0, path: [] };
  }

  const cacheKey = `${currentIndex}:${visitedMask}`;
  const cached = memo.get(cacheKey);
  if (cached) {
    return cached;
  }

  let bestCost = Number.POSITIVE_INFINITY;
  let bestPath: number[] = [];

  for (let nextIndex = 0; nextIndex < nodes.length; nextIndex += 1) {
    if ((visitedMask & (1 << nextIndex)) !== 0) {
      continue;
    }

    const nextNode = nodes[nextIndex];
    if (
      nextNode.kind === 'dropoff' &&
      (visitedMask & (1 << nextNode.pairedPickupIndex)) === 0
    ) {
      continue;
    }

    const segmentDistanceKm = haversineKm(nodes[currentIndex], nextNode);
    const nextResult = solveExact(
      nodes,
      nextIndex,
      visitedMask | (1 << nextIndex),
      memo,
    );
    const totalCost = segmentDistanceKm + nextResult.cost;

    if (totalCost < bestCost) {
      bestCost = totalCost;
      bestPath = [nextIndex, ...nextResult.path];
    }
  }

  const result = { cost: bestCost, path: bestPath };
  memo.set(cacheKey, result);
  return result;
}

function greedyNearestNeighbour(
  nodes: StopNode[],
  anchorPickupIndex: number,
): SequenceResult {
  const visited = new Set<number>([anchorPickupIndex]);
  const orderedNodeIndices = [anchorPickupIndex];
  let currentIndex = anchorPickupIndex;
  let totalDistanceKm = 0;

  while (visited.size < nodes.length) {
    let bestIndex = -1;
    let bestDistanceKm = Number.POSITIVE_INFINITY;

    for (let nextIndex = 0; nextIndex < nodes.length; nextIndex += 1) {
      if (visited.has(nextIndex)) {
        continue;
      }

      const nextNode = nodes[nextIndex];
      if (
        nextNode.kind === 'dropoff' &&
        !visited.has(nextNode.pairedPickupIndex)
      ) {
        continue;
      }

      const distanceKm = haversineKm(nodes[currentIndex], nextNode);
      if (distanceKm < bestDistanceKm) {
        bestDistanceKm = distanceKm;
        bestIndex = nextIndex;
      }
    }

    if (bestIndex < 0) {
      throw new Error('Could not build a valid pickup/dropoff sequence');
    }

    totalDistanceKm += bestDistanceKm;
    visited.add(bestIndex);
    orderedNodeIndices.push(bestIndex);
    currentIndex = bestIndex;
  }

  return {
    stops: orderedNodeIndices.map((nodeIndex, sequence) =>
      nodeToStop(nodes[nodeIndex], sequence),
    ),
    heuristicDistanceKm: round3(totalDistanceKm),
    algorithm: 'greedy_nearest_neighbour',
  };
}

function nodeToStop(node: StopNode, sequence: number): PlannedGroupStop {
  return {
    rideId: node.rideId,
    riderId: node.riderId,
    sequence,
    kind: node.kind,
    lat: node.lat,
    lng: node.lng,
    address: node.address,
  };
}
