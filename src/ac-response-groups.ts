export interface AcResponseEdge {
  partId: string;
  positiveNode: number;
  negativeNode: number;
}

interface BlockSearch {
  edges: readonly AcResponseEdge[];
  adjacency: number[][];
  discovery: number[];
  low: number[];
  stack: number[];
  parents: Map<string, string>;
  time: number;
}

function findGroup(parents: Map<string, string>, partId: string): string {
  let root = parents.get(partId) ?? partId;
  let next = parents.get(root);
  while (next !== undefined && next !== root) { root = next; next = parents.get(root); }
  parents.set(partId, root);
  return root;
}

function finishBlock(search: BlockSearch, lastEdge: number) {
  let group: string | undefined;
  while (search.stack.length > 0) {
    const index = search.stack.pop()!;
    const edge = search.edges[index]!;
    const next = findGroup(search.parents, edge.partId);
    if (group === undefined) { group = next; }
    else { search.parents.set(next, findGroup(search.parents, group)); }
    if (index === lastEdge) { break; }
  }
}

function visitBlock(search: BlockSearch, node: number, parentEdge: number) {
  search.time += 1;
  search.discovery[node] = search.time;
  search.low[node] = search.time;
  for (const index of search.adjacency[node] ?? []) {
    if (index === parentEdge) { continue; }
    const edge = search.edges[index]!;
    const next = edge.positiveNode === node ? edge.negativeNode : edge.positiveNode;
    if (search.discovery[next] === 0) {
      search.stack.push(index);
      visitBlock(search, next, index);
      search.low[node] = Math.min(search.low[node]!, search.low[next]!);
      if (search.low[next]! >= search.discovery[node]!) { finishBlock(search, index); }
    } else if (search.discovery[next]! < search.discovery[node]!) {
      search.stack.push(index);
      search.low[node] = Math.min(search.low[node]!, search.discovery[next]!);
    }
  }
}

/** Voltage/current responses can be independent across a shared articulation node. */
export function acResponsePartGroups(nodeCount: number, edges: readonly AcResponseEdge[]) {
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  const parents = new Map<string, string>();
  for (const [index, edge] of edges.entries()) {
    parents.set(edge.partId, edge.partId);
    if (edge.positiveNode === edge.negativeNode) { continue; }
    adjacency[edge.positiveNode]!.push(index);
    adjacency[edge.negativeNode]!.push(index);
  }
  const search: BlockSearch = { edges, adjacency, parents, time: 0, stack: [],
    discovery: Array.from({ length: nodeCount }, () => 0), low: Array.from({ length: nodeCount }, () => 0) };
  for (let node = 0; node < nodeCount; node += 1) {
    if (search.discovery[node] === 0) { visitBlock(search, node, -1); }
  }
  return new Map([...parents.keys()].map((partId) => [partId, findGroup(parents, partId)]));
}
