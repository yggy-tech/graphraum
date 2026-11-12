import type { GraphraumDataPatch, GraphraumEdge, GraphraumNode } from "./types";

/** What the graph currently holds, by id. */
export interface DrawnSet {
	edges: Map<string, GraphraumEdge>;
	nodes: Map<string, GraphraumNode>;
}

/** The patch that turns `drawn` into `next`: only nodes and edges that left or arrived are named. */
export function diffDrawn(drawn: DrawnSet, next: DrawnSet): GraphraumDataPatch {
	const removedNodeIds = [...drawn.nodes.keys()].filter((id) => !next.nodes.has(id));
	const removedEdgeIds = [...drawn.edges.keys()].filter((id) => !next.edges.has(id));
	const addedNodes = [...next.nodes].filter(([id]) => !drawn.nodes.has(id)).map(([, node]) => node);
	const addedEdges = [...next.edges].filter(([id]) => !drawn.edges.has(id)).map(([, edge]) => edge);
	return { addedEdges, addedNodes, removedEdgeIds, removedNodeIds };
}
