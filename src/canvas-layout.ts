export const NODE_W = 304;
export const NODE_H_GAP = 44;
export const NODE_W_GAP = 156;

export interface LayoutNode {
  id: string;
  type?: string;
  outputs?: Array<unknown>;
  depends_on?: string[];
}

export function excerptText(text: string, max: number): { excerpt: string; truncated: boolean } {
  const truncated = text.length > max;
  return { excerpt: truncated ? text.slice(0, max) + "…" : text, truncated };
}

export function estimateNodeHeight(node: LayoutNode): number {
  const outputs = node.outputs?.length ?? 0;
  const outputRows = outputs > 0 ? 1 : 0;
  const gateRow = node.type === "reviewer" ? 18 : 0;
  return 126 + outputRows * 26 + gateRow;
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

function longestPathStages(ids: string[], edges: Array<{ from: string; to: string }>): string[][] {
  const indeg: Record<string, number> = {};
  const nextById: Record<string, string[]> = {};
  const rank: Record<string, number> = {};
  for (const id of ids) {
    indeg[id] = 0;
    nextById[id] = [];
    rank[id] = 0;
  }
  for (const edge of edges) {
    if (!(edge.from in indeg) || !(edge.to in indeg)) continue;
    indeg[edge.to]++;
    nextById[edge.from].push(edge.to);
  }

  const queue = ids.filter((id) => indeg[id] === 0);
  const seen = new Set<string>();
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    seen.add(id);
    for (const to of nextById[id]) {
      rank[to] = Math.max(rank[to], rank[id] + 1);
      indeg[to]--;
      if (indeg[to] === 0) queue.push(to);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) rank[id] = Math.max(...Object.values(rank), 0) + 1;
  }

  const rightmost = Math.max(...Object.values(rank), 0);
  const hasOutgoing = new Set(edges.filter((edge) => edge.from in rank && edge.to in rank).map((edge) => edge.from));
  for (const id of ids) {
    if (!hasOutgoing.has(id)) rank[id] = rightmost;
  }

  const stages: string[][] = [];
  for (const id of ids) (stages[rank[id]] ??= []).push(id);
  return stages.filter(Boolean);
}

export function computePositions(
  nodes: LayoutNode[],
  edges: Array<{ from: string; to: string }>,
): Record<string, { x: number; y: number }> {
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const stages = reduceCrossings(longestPathStages(nodes.map((node) => node.id), edges), edges);
  const stepX = NODE_W + NODE_W_GAP;
  const heights = Object.fromEntries(nodes.map((node) => [node.id, estimateNodeHeight(node)]));
  const stageHeights = stages.map((stage) => stage.reduce((sum, id, i) => sum + heights[id] + (i ? NODE_H_GAP : 0), 0));
  const maxStageHeight = Math.max(...stageHeights, 0);
  const pos: Record<string, { x: number; y: number }> = {};

  stages.forEach((stage, si) => {
    let y = Math.max(0, (maxStageHeight - stageHeights[si]) / 2);
    stage.forEach((id) => {
      const node = byId[id];
      const fan = edges.filter((edge) => edge.from === id || edge.to === id).length;
      const repel = Math.min(fan * 3, 24);
      pos[id] = { x: si * stepX, y };
      y += estimateNodeHeight(node) + NODE_H_GAP + repel;
    });
  });

  return pos;
}
