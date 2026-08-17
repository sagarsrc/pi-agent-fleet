export const NODE_W = 284;
export const NODE_H_GAP = 200;
export const NODE_W_GAP = 40;

export function excerptText(text: string, max: number): { excerpt: string; truncated: boolean } {
  const truncated = text.length > max;
  return { excerpt: truncated ? text.slice(0, max) + "…" : text, truncated };
}

export function topoLayers(ids: string[], edges: Array<{ from: string; to: string }>): string[][] {
  const indeg: Record<string, number> = {};
  const nextById: Record<string, string[]> = {};
  for (const id of ids) {
    indeg[id] = 0;
    nextById[id] = [];
  }
  for (const edge of edges) {
    if (!(edge.from in indeg) || !(edge.to in indeg)) continue;
    indeg[edge.to]++;
    nextById[edge.from].push(edge.to);
  }

  const layers: string[][] = [];
  const seen = new Set<string>();
  let cur = ids.filter((id) => indeg[id] === 0);
  while (cur.length) {
    layers.push(cur);
    const next: string[] = [];
    for (const id of cur) {
      seen.add(id);
      for (const to of nextById[id]) {
        indeg[to]--;
        if (indeg[to] === 0) next.push(to);
      }
    }
    cur = next;
  }

  for (const id of ids) {
    if (seen.has(id)) continue;
    layers.push([id]);
    seen.add(id);
  }
  return layers;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function reduceCrossings(layers: string[][], edges: Array<{ from: string; to: string }>): string[][] {
  const ordered = layers.map((layer) => layer.slice());
  for (let li = 1; li < ordered.length; li++) {
    const prevPos: Record<string, number> = {};
    ordered[li - 1].forEach((id, i) => {
      prevPos[id] = i;
    });
    const key = (id: string) => median(edges.filter((edge) => edge.to === id).map((edge) => prevPos[edge.from] ?? 0));
    ordered[li].sort((a, b) => key(a) - key(b) || a.localeCompare(b));
  }
  return ordered;
}

export function computePositions(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
): Record<string, { x: number; y: number }> {
  const layers = reduceCrossings(topoLayers(nodes.map((node) => node.id), edges), edges);
  const maxLayerLen = layers.reduce((max, layer) => Math.max(max, layer.length), 0);
  const stepX = NODE_W + NODE_W_GAP;
  const pos: Record<string, { x: number; y: number }> = {};

  layers.forEach((layer, li) => {
    const xOffset = ((maxLayerLen - layer.length) * stepX) / 2;
    layer.forEach((id, ni) => {
      pos[id] = { x: xOffset + ni * stepX, y: li * NODE_H_GAP };
    });
  });
  return pos;
}
