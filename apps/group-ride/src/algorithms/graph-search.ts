export type WeightedEdge = {
  to: string;
  weight: number;
};

export type WeightedGraph = Map<string, WeightedEdge[]>;

export type ShortestPathResult = {
  distance: number;
  path: string[];
};

// Generic graph search helpers for offline experimentation.
// The live service uses Google Routes for road-level navigation, but keeping
// these in-tree makes it easy to benchmark heuristics and test local graphs.
export function dijkstraShortestPath(
  graph: WeightedGraph,
  start: string,
  goal: string,
): ShortestPathResult | null {
  return searchGraph(graph, start, goal, () => 0);
}

export function aStarShortestPath(
  graph: WeightedGraph,
  start: string,
  goal: string,
  heuristic: (nodeId: string) => number,
): ShortestPathResult | null {
  return searchGraph(graph, start, goal, heuristic);
}

function searchGraph(
  graph: WeightedGraph,
  start: string,
  goal: string,
  heuristic: (nodeId: string) => number,
): ShortestPathResult | null {
  const frontier = new Map<string, number>([[start, heuristic(start)]]);
  const bestDistance = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, string | null>([[start, null]]);

  while (frontier.size > 0) {
    const current = minByValue(frontier);
    if (!current) {
      break;
    }

    frontier.delete(current.nodeId);
    if (current.nodeId === goal) {
      return {
        distance: bestDistance.get(goal) ?? Number.POSITIVE_INFINITY,
        path: reconstructPath(previous, goal),
      };
    }

    const currentDistance = bestDistance.get(current.nodeId);
    if (currentDistance === undefined) {
      continue;
    }

    for (const edge of graph.get(current.nodeId) ?? []) {
      const nextDistance = currentDistance + edge.weight;
      if (nextDistance >= (bestDistance.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      bestDistance.set(edge.to, nextDistance);
      previous.set(edge.to, current.nodeId);
      frontier.set(edge.to, nextDistance + heuristic(edge.to));
    }
  }

  return null;
}

function minByValue(map: Map<string, number>): { nodeId: string; value: number } | null {
  let bestNodeId: string | null = null;
  let bestValue = Number.POSITIVE_INFINITY;

  for (const [nodeId, value] of map) {
    if (value < bestValue) {
      bestNodeId = nodeId;
      bestValue = value;
    }
  }

  return bestNodeId === null ? null : { nodeId: bestNodeId, value: bestValue };
}

function reconstructPath(previous: Map<string, string | null>, goal: string): string[] {
  const path: string[] = [];
  let current: string | null = goal;

  while (current) {
    path.push(current);
    current = previous.get(current) ?? null;
  }

  return path.reverse();
}
