import { DEFAULT_NODE_SIZE } from "./lod-source";
import type { GraphraumDataPatch, GraphraumEdge, GraphraumNode } from "./types";

/** What the graph currently holds, by id. */
export interface DrawnSet {
	edges: Map<string, GraphraumEdge>;
	nodes: Map<string, GraphraumNode>;
}

/** Sizes and positions that differ by less than this share are the same: scaling a size and back is not exact. */
const SAME_WITHIN = 1e-6;

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === "number" && typeof b === "number") {
		return Math.abs(a - b) <= SAME_WITHIN * Math.max(1, Math.abs(a), Math.abs(b));
	}
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) if (!sameValue(left[key], right[key])) return false;
	return true;
}

/** The size a node draws at: a node with no size at all draws at the default. */
const drawnSize = (node: GraphraumNode) =>
	node.size ?? (node.width === undefined && node.height === undefined ? DEFAULT_NODE_SIZE : undefined);

const nearNumbers = (a: number, b: number) => sameValue(a, b);

/** Whether two nodes with one id draw the same: place, size, colour, blend and the rest of what they carry. */
export function sameNode(a: GraphraumNode, b: GraphraumNode): boolean {
	if (a === b) return true;
	if (
		!nearNumbers(a.position.x, b.position.x) ||
		!nearNumbers(a.position.y, b.position.y) ||
		!nearNumbers(a.position.z ?? 0, b.position.z ?? 0)
	) {
		return false;
	}
	const sizeA = drawnSize(a);
	const sizeB = drawnSize(b);
	if (sizeA === undefined || sizeB === undefined ? sizeA !== sizeB : !nearNumbers(sizeA, sizeB)) return false;
	const left = a as unknown as Record<string, unknown>;
	const right = b as unknown as Record<string, unknown>;
	for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
		if (key === "position" || key === "size") continue;
		if (!sameValue(left[key], right[key])) return false;
	}
	return true;
}

/**
 * The patch that turns `drawn` into `next`. Nodes and edges that left or arrived are named, and so is one that
 * kept its id but not its look: an id is not an identity, because a rebuilt tree gives an old cluster id to another
 * cluster, and a patch that skipped it would leave the old glyph on screen under the new one's id.
 */
export function diffDrawn(drawn: DrawnSet, next: DrawnSet): GraphraumDataPatch {
	const removedNodeIds = [...drawn.nodes.keys()].filter((id) => !next.nodes.has(id));
	const removedEdgeIds = [...drawn.edges.keys()].filter((id) => !next.edges.has(id));
	const addedNodes = [...next.nodes]
		.filter(([id, node]) => {
			const held = drawn.nodes.get(id);
			return held === undefined || !sameNode(held, node);
		})
		.map(([, node]) => node);
	const addedEdges = [...next.edges]
		.filter(([id, edge]) => {
			const held = drawn.edges.get(id);
			return held === undefined || !sameValue(held, edge);
		})
		.map(([, edge]) => edge);
	return { addedEdges, addedNodes, removedEdgeIds, removedNodeIds };
}
