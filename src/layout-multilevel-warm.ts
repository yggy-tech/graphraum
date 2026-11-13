/**
 * Warm start of the multilevel layout: settle only the part of the graph that changed. New nodes start at
 * the mean of their placed neighbours; the nodes whose edges or anchors changed, the new nodes and their
 * neighbourhoods are refined while every other node keeps its position exactly.
 */

import {
	computeForcePositions,
	createRegionForceSimulation,
	DEFAULT_FORCE_SETTINGS,
	type ForceAnchors,
	type ForceLayoutRequest,
} from "./force-layout";
import { baseCoarseLevel, type CoarseLevel } from "./graph-coarsen";

/** The graph and anchors of the layout a warm start continues from. */
export interface PreviousLayout {
	/** Anchors of the previous layout, to find the nodes whose anchor moved. */
	anchors?: ForceAnchors;
	/** Edge endpoint pairs of the previous layout. */
	edges: Uint32Array;
	/** Nodes of the previous layout; nodes at or past this id are new. */
	nodeCount: number;
}

/** Hops around a changed node that are refined too. */
const NEIGHBOURHOOD_HOPS = 2;
/** Above this share of the nodes the whole graph is settled, as the plain warm start does. */
const WHOLE_GRAPH_SHARE = 0.5;
const WARM_STEPS = 8;
const WARM_ALPHA = 0.1;
/** Passes that place chains of new nodes, each from the nodes placed before it. */
const PLACEMENT_PASSES = 4;

function hash32(seed: number) {
	let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
	value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
	return (value ^ (value >>> 16)) >>> 0;
}

const unit = (seed: number) => hash32(seed) / 0x1_0000_0000;

function edgeKeys(edges: Uint32Array, nodeCount: number) {
	const keys = new Float64Array(edges.length / 2);
	let count = 0;
	for (let index = 0; index < edges.length; index += 2) {
		const source = edges[index] ?? 0;
		const target = edges[index + 1] ?? 0;
		if (source === target) continue;
		keys[count++] = Math.min(source, target) * nodeCount + Math.max(source, target);
	}
	return keys.subarray(0, count).sort();
}

/** Marks both ends of every edge present in only one of the two edge lists. */
function markChangedEdges(dirty: Uint8Array, previous: Uint32Array, next: Uint32Array, nodeCount: number) {
	const before = edgeKeys(previous, nodeCount);
	const after = edgeKeys(next, nodeCount);
	const mark = (key: number) => {
		dirty[Math.floor(key / nodeCount)] = 1;
		dirty[key % nodeCount] = 1;
	};
	let left = 0;
	let right = 0;
	while (left < before.length && right < after.length) {
		const a = before[left] as number;
		const b = after[right] as number;
		if (a === b) {
			left += 1;
			right += 1;
		} else if (a < b) mark(before[left++] as number);
		else mark(after[right++] as number);
	}
	while (left < before.length) mark(before[left++] as number);
	while (right < after.length) mark(after[right++] as number);
}

function markMovedAnchors(
	dirty: Uint8Array,
	anchors: ForceAnchors | undefined,
	previous: ForceAnchors | undefined,
	previousCount: number,
	dimensions: 2 | 3,
	nodeCount: number,
) {
	if (!anchors) return;
	const same = (left: number, right: number) => left === right || (Number.isNaN(left) && Number.isNaN(right));
	const strengthOf = (source: ForceAnchors, node: number) =>
		source.strength instanceof Float32Array ? (source.strength[node] ?? 1) : (source.strength ?? 1);
	for (let node = 0; node < Math.min(nodeCount, previousCount); node += 1) {
		let moved = !previous || strengthOf(anchors, node) !== strengthOf(previous, node);
		for (let axis = 0; axis < dimensions && !moved; axis += 1) {
			moved = !same(
				anchors.positions[node * dimensions + axis] ?? 0,
				previous?.positions[node * dimensions + axis] ?? 0,
			);
		}
		if (moved) dirty[node] = 1;
	}
}

/** Starts each new node (NaN position) at the mean of its placed neighbours, plus a small jitter. */
function placeNewNodes(start: Float32Array, isNew: Uint8Array, level: CoarseLevel, dimensions: 2 | 3, spread: number) {
	for (let pass = 0; pass < PLACEMENT_PASSES; pass += 1) {
		const placed: number[] = [];
		for (let node = 0; node < level.nodeCount; node += 1) {
			if (!isNew[node]) continue;
			let count = 0;
			const sum = [0, 0, 0];
			for (let slot = level.rowPtr[node] ?? 0; slot < (level.rowPtr[node + 1] ?? 0); slot += 1) {
				const neighbour = level.col[slot] ?? 0;
				if (isNew[neighbour]) continue;
				count += 1;
				for (let axis = 0; axis < dimensions; axis += 1) sum[axis] += start[neighbour * 3 + axis] ?? 0;
			}
			if (count === 0) continue;
			for (let axis = 0; axis < dimensions; axis += 1) {
				start[node * 3 + axis] = (sum[axis] ?? 0) / count + (unit(node * 8 + axis + pass) - 0.5) * spread;
			}
			placed.push(node);
		}
		for (const node of placed) isNew[node] = 0;
		if (placed.length === 0) break;
	}
}

/** Marks the nodes within `hops` of a marked node. */
function growNeighbourhood(dirty: Uint8Array, level: CoarseLevel, hops: number) {
	let frontier: number[] = [];
	for (let node = 0; node < level.nodeCount; node += 1) if (dirty[node]) frontier.push(node);
	for (let hop = 0; hop < hops; hop += 1) {
		const next: number[] = [];
		for (const node of frontier) {
			for (let slot = level.rowPtr[node] ?? 0; slot < (level.rowPtr[node + 1] ?? 0); slot += 1) {
				const neighbour = level.col[slot] ?? 0;
				if (dirty[neighbour]) continue;
				dirty[neighbour] = 1;
				next.push(neighbour);
			}
		}
		frontier = next;
	}
}

/**
 * Settles `request.initialPositions` after a change. Nodes whose edges or anchors differ from `previous`,
 * new nodes (NaN start, or past `previous.nodeCount`) and `NEIGHBOURHOOD_HOPS` of their neighbours are
 * refined; the rest stay put. Without `previous` only the new nodes count as changed, and a graph
 * without new nodes settles as a whole like `computeForcePositions()`. With `previous` and no change the
 * positions come back as they are. When more than half of the nodes would move, the whole graph settles.
 */
export function computeWarmStartPositions(request: ForceLayoutRequest, previous?: PreviousLayout): Float32Array {
	const { dimensions, nodeCount } = request;
	const start = request.initialPositions;
	if (!start || start.length !== nodeCount * 3) return computeForcePositions(request);
	const level = baseCoarseLevel(nodeCount, request.edges);
	const dirty = new Uint8Array(nodeCount);
	const isNew = new Uint8Array(nodeCount);
	for (let node = 0; node < nodeCount; node += 1) {
		const known =
			Number.isFinite(start[node * 3]) &&
			Number.isFinite(start[node * 3 + 1]) &&
			(dimensions === 2 || Number.isFinite(start[node * 3 + 2]));
		if (!known || (previous && node >= previous.nodeCount)) dirty[node] = 1;
		if (!known) isNew[node] = 1;
	}
	if (previous) {
		markChangedEdges(dirty, previous.edges, request.edges, Math.max(nodeCount, previous.nodeCount, 1));
		markMovedAnchors(dirty, request.anchors, previous.anchors, previous.nodeCount, dimensions, nodeCount);
	}
	let changed = 0;
	for (let node = 0; node < nodeCount; node += 1) changed += dirty[node] ?? 0;
	// With no `previous` there is no way to tell what changed, so a graph of known positions just settles.
	if (changed === 0) return previous ? Float32Array.from(start) : computeForcePositions(request);

	const linkDistance = request.settings?.linkDistance ?? DEFAULT_FORCE_SETTINGS.linkDistance;
	const positions = Float32Array.from(start);
	placeNewNodes(positions, isNew, level, dimensions, linkDistance);
	growNeighbourhood(dirty, level, NEIGHBOURHOOD_HOPS);
	const owned = Uint32Array.from({ length: nodeCount }, (_, node) => node).filter((node) => dirty[node]);
	if (owned.length > nodeCount * WHOLE_GRAPH_SHARE)
		return computeForcePositions({ ...request, initialPositions: positions });

	const simulation = createRegionForceSimulation({ ...request, initialPositions: positions, warmStart: true }, owned);
	for (let step = 0; step < WARM_STEPS; step += 1) simulation.step(WARM_ALPHA * (1 - step / WARM_STEPS));
	return simulation.positions;
}
