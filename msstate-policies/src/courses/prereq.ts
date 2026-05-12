/**
 * Forward + reverse DAG walker for the course corpus.
 *
 * Forward direction ("prereqs"): from root, follow `forward_dag` edges
 * (course → its prereqs). Useful for "what do I need to take before X?".
 *
 * Reverse direction ("unlocks"): from root, follow `reverse_dag` edges
 * (prereq → courses that require it). Useful for "what unlocks after X?".
 *
 * Cycle detection via visited-set. Depth clamped to [MIN_GRAPH_DEPTH,
 * MAX_GRAPH_DEPTH]. Result includes `truncated: true` whenever the walk
 * stopped early (depth cap or cycle), so the client knows the picture
 * is partial.
 */
import {
  type CourseCorpus,
  type GraphEdge,
  type GraphNode,
  type GraphResult,
  DEFAULT_GRAPH_DEPTH,
  MAX_GRAPH_DEPTH,
  MIN_GRAPH_DEPTH,
} from "./types.js";

function clampDepth(d: number | undefined): { value: number; clamped: boolean } {
  const want = typeof d === "number" && Number.isFinite(d) ? Math.floor(d) : DEFAULT_GRAPH_DEPTH;
  const value = Math.min(MAX_GRAPH_DEPTH, Math.max(MIN_GRAPH_DEPTH, want));
  return { value, clamped: value !== want };
}

export function walkGraph(
  corpus: CourseCorpus,
  rootCode: string,
  direction: "prereqs" | "unlocks",
  depthRequested?: number,
): GraphResult {
  const { value: depth_used_max, clamped } = clampDepth(depthRequested);
  const notes: string[] = [];
  if (clamped) {
    notes.push(`depth clamped from ${depthRequested} to ${depth_used_max}`);
  }

  const root = corpus.records[rootCode];
  if (!root) {
    return {
      root: rootCode,
      direction,
      depth_requested: depthRequested ?? DEFAULT_GRAPH_DEPTH,
      depth_used: 0,
      nodes: [],
      edges: [],
      truncated: false,
      notes: notes.concat([`course not in corpus: ${rootCode}`]),
    };
  }

  const adj = direction === "prereqs" ? corpus.forward_dag : corpus.reverse_dag;
  const nodes: GraphNode[] = [{ code: rootCode, title: root.title, depth: 0 }];
  const edges: GraphEdge[] = [];
  const visited = new Set<string>([rootCode]);
  let truncated = false;
  let depth_used = 0;

  let frontier: Array<{ code: string; depth: number }> = [{ code: rootCode, depth: 0 }];
  while (frontier.length > 0) {
    const next: Array<{ code: string; depth: number }> = [];
    for (const { code, depth } of frontier) {
      if (depth >= depth_used_max) {
        if ((adj[code] ?? []).length > 0) truncated = true;
        continue;
      }
      const neighbors = adj[code] ?? [];
      for (const n of neighbors) {
        if (visited.has(n)) {
          notes.push(`cycle detected at ${n}`);
          truncated = true;
          continue;
        }
        visited.add(n);
        const c = corpus.records[n];
        const title = c?.title ?? "(unknown)";
        nodes.push({ code: n, title, depth: depth + 1 });
        // Edge metadata: in forward direction, the edge represents
        // "code requires n", carrying the logic/grade from code's prereqs.
        // In reverse, the edge "n is unlocked by code" — surface the same
        // metadata, just looked up via the source course.
        const sourceCode = direction === "prereqs" ? code : n;
        const sc = corpus.records[sourceCode];
        const p = sc?.prereqs;
        edges.push({
          from: code,
          to: n,
          logic: p?.logic ?? null,
          min_grade: p?.min_grade ?? null,
        });
        next.push({ code: n, depth: depth + 1 });
        depth_used = Math.max(depth_used, depth + 1);
      }
    }
    frontier = next;
  }

  return {
    root: rootCode,
    direction,
    depth_requested: depthRequested ?? DEFAULT_GRAPH_DEPTH,
    depth_used,
    nodes,
    edges,
    truncated,
    notes,
  };
}
