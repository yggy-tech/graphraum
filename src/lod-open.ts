import type { ClusterTree, ClusterTreeInput } from "./cluster-tree";
import { type ClusterTreeJob, type ClusterTreeJobOptions, startClusterTreeJob } from "./cluster-tree-job";
import { attachClusterLod, type ClusterLodGraph, type ClusterLodHandle, type ClusterLodOptions } from "./lod-attach";
import { colorKeyHex } from "./lod-format";
import type { ClusterLodSource } from "./lod-source";
import type { GraphraumEdge, GraphraumNode } from "./types";

/** The typed arrays the full graph lives in. Node `i` is `positions[i * dimensions ...]`, edge `k` is `edges[k * 2]` and `edges[k * 2 + 1]`. */
export interface ClusterLodArrays {
	/** One 0xRRGGBB per node, when you gave them. */
	colors: Uint32Array | undefined;
	dimensions: 2 | 3;
	/** Two node indices per edge. Empty until the tree has its edges. */
	edges: Uint32Array;
	/** The positions as the tree holds them. */
	positions: Float32Array;
}

export interface OpenClusterLodOptions extends Omit<ClusterLodOptions, "data" | "source">, ClusterTreeJobOptions {
	/** Aborts the open: stops the worker and rejects. After the handle resolved, use `detach()`. */
	signal?: AbortSignal;
	/** The real edge `index`, drawn when both its nodes are in the cut. Default: id `e<index>` between `n<source>` and `n<target>`. */
	edge?: (index: number, arrays: ClusterLodArrays) => GraphraumEdge;
	/** The real node `index`, drawn when it is in the cut. Default: id `n<index>`, its position, and its colour when you gave colours. */
	node?: (index: number, arrays: ClusterLodArrays) => GraphraumNode;
}

export interface ClusterLodTimings {
	/** Milliseconds from the call until the first cut was drawn. */
	firstCutMilliseconds: number;
	/** Milliseconds from the call until the edges were in and drawn; null while they build. */
	completeMilliseconds: number | null;
	/** Milliseconds the builder spent on the clusters, and on the edges (null while they build). In a worker, off the main thread. */
	buildCoarseMilliseconds: number;
	buildEdgesMilliseconds: number | null;
}

export interface OpenedClusterLod extends ClusterLodHandle {
	/** The arrays the full graph lives in; the edges fill in when `complete` resolves. */
	arrays: ClusterLodArrays;
	/** Resolves when the aggregate edges are in and drawn. Rejects when building them failed. */
	complete: Promise<void>;
	getTimings(): ClusterLodTimings;
	/** The tree. It has no edges until `complete` resolves. */
	tree: ClusterTree;
	/** Whether a worker built the tree. */
	usedWorker: boolean;
}

function defaultNode(index: number, arrays: ClusterLodArrays): GraphraumNode {
	const { colors, dimensions, positions } = arrays;
	const base = index * dimensions;
	return {
		...(colors ? { color: colorKeyHex(colors[index] as number) } : {}),
		id: `n${index}`,
		position:
			dimensions === 3
				? { x: positions[base] as number, y: positions[base + 1] as number, z: positions[base + 2] as number }
				: { x: positions[base] as number, y: positions[base + 1] as number },
	};
}

function defaultEdge(index: number, arrays: ClusterLodArrays): GraphraumEdge {
	return {
		id: `e${index}`,
		source: `n${arrays.edges[index * 2]}`,
		target: `n${arrays.edges[index * 2 + 1]}`,
	};
}

const abortError = () => new DOMException("Opening cluster LOD was aborted.", "AbortError");

/**
 * Opens a huge graph straight into a cluster view. A worker builds the cluster tree from the typed arrays
 * and posts it in two steps, so the coarse regions show as soon as they exist and the aggregate edges follow;
 * graphraum only ever receives the cut. Without a worker the same steps run on this thread. The returned
 * promise resolves with the first cut drawn.
 *
 * The full graph stays in typed arrays, never one object per node. With the default `transfer` the arrays you pass
 * are handed to the worker and detached; read positions, colours and edges through the returned `arrays`, which `node` and `edge` also receive. Do not call `setData` yourself while the layer is attached.
 */
export async function openClusterLod(
	graph: ClusterLodGraph,
	input: ClusterTreeInput,
	options: OpenClusterLodOptions,
): Promise<OpenedClusterLod> {
	const { edge, node, signal, ...rest } = options;
	const { createWorker, transfer, worker, ...lodOptions } = rest;
	if (signal?.aborted) throw abortError();
	const startedAt = performance.now();
	const job: ClusterTreeJob = startClusterTreeJob(input, {
		...(createWorker ? { createWorker } : {}),
		...(transfer === undefined ? {} : { transfer }),
		...(worker === undefined ? {} : { worker }),
	});
	const onAbort = () => job.terminate();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const coarse = await job.coarse;
		if (signal?.aborted) throw abortError();
		const { tree } = coarse;
		const arrays: ClusterLodArrays = {
			colors: coarse.colors,
			dimensions: tree.dimensions,
			edges: new Uint32Array(0),
			positions: tree.positions,
		};
		const source: ClusterLodSource = {
			edge: (index) => (edge ?? defaultEdge)(index, arrays),
			node: (index) => (node ?? defaultNode)(index, arrays),
			nodeCount: tree.nodeCount,
		};
		const handle = attachClusterLod(graph, tree, { ...lodOptions, source });
		const timings: ClusterLodTimings = {
			buildCoarseMilliseconds: coarse.buildMilliseconds,
			buildEdgesMilliseconds: null,
			completeMilliseconds: null,
			firstCutMilliseconds: performance.now() - startedAt,
		};
		let detached = false;
		const complete = job.finished.then(
			(finished) => {
				signal?.removeEventListener("abort", onAbort);
				if (detached) return;
				Object.assign(tree, finished.edges);
				arrays.edges = finished.edgeList;
				timings.buildEdgesMilliseconds = finished.buildMilliseconds;
				timings.completeMilliseconds = performance.now() - startedAt;
				handle.refresh();
			},
			(error: unknown) => {
				if (!detached) throw error;
			},
		);
		return {
			...handle,
			arrays,
			complete,
			detach() {
				detached = true;
				job.terminate();
				handle.detach();
			},
			getTimings: () => ({ ...timings }),
			tree,
			usedWorker: job.usedWorker,
		};
	} catch (error) {
		job.terminate();
		signal?.removeEventListener("abort", onAbort);
		throw error;
	}
}
