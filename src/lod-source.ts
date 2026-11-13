import type { GraphraumData, GraphraumEdge, GraphraumNode } from "./types";

/**
 * Where cluster LOD reads the real nodes and edges it draws. Node `i` is the position `i` of the tree and edge `k`
 * is the pair `k` of its edge list. Only nodes and edges inside a cut are ever asked for, so a source can build them
 * on demand from typed arrays and hold no per-node objects.
 */
export interface ClusterLodSource {
	/** The edge with this index, with the ids of its two nodes. */
	edge(index: number): GraphraumEdge;
	/** The index of a node id, for ids the layer has not drawn. Optional: ids the layer drew are found without it. */
	indexOf?(id: string): number | undefined;
	/** The node with this index. */
	node(index: number): GraphraumNode;
	nodeCount: number;
}

/** Size graphraum draws a node at when it has none. */
export const DEFAULT_NODE_SIZE = 4;

/** A source over a full `GraphraumData`. */
export function sourceOfData(data: GraphraumData): ClusterLodSource {
	let indexById: Map<string, number> | null = null;
	return {
		edge: (index) => data.edges[index] as GraphraumEdge,
		indexOf(id) {
			indexById ??= new Map(data.nodes.map((node, index) => [node.id, index]));
			return indexById.get(id);
		},
		node: (index) => data.nodes[index] as GraphraumNode,
		nodeCount: data.nodes.length,
	};
}

/** The mean size of the first nodes, which sizes the aggregate glyphs next to them. */
export function sampleNodeRadius(source: ClusterLodSource): number {
	const count = Math.min(256, source.nodeCount);
	let total = 0;
	for (let index = 0; index < count; index += 1) {
		const node = source.node(index);
		total += node.size ?? node.width ?? DEFAULT_NODE_SIZE;
	}
	return total / Math.max(count, 1);
}

/** The source of the options: the given `source`, or one over `data`. */
export function lodSourceOf(options: { data?: GraphraumData; source?: ClusterLodSource }): ClusterLodSource {
	const source = options.source ?? (options.data ? sourceOfData(options.data) : null);
	if (!source) throw new Error("Cluster LOD needs `data` or a `source`.");
	return source;
}
