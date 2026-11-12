import { DEFAULT_FORCE_SETTINGS, type ForceSettings, forceIterationCount } from "../../../src/force-layout";
import { type LayoutStability, measureLayoutStability } from "../../../src/layout-stability";

/** Where a multilevel layout spent its worker time, in milliseconds. */
export interface MultilevelPhaseTiming {
	coarsenMs: number;
	coarsestMs: number;
	levels: number;
	refineMs: number;
}

export interface ProgressiveLayoutTiming {
	batchCount: number;
	batchSize: number;
	completeMilliseconds: number;
	computeMilliseconds: number;
	firstUsefulFrameMilliseconds: number;
	iterations: number;
	kind: "force";
	nodeCount: number;
	/** Multilevel runs only: the worker's time per phase. */
	phases?: MultilevelPhaseTiming;
	startupMilliseconds: number;
	transferMilliseconds: number;
}

export interface ProgressiveLayoutPositionsMessage {
	computeMilliseconds?: number;
	end: number;
	phases?: MultilevelPhaseTiming;
	/** A rough full-graph layout posted before the final positions; the final batches still follow. */
	preview?: boolean;
	positions: Float32Array;
	run: number;
	type: "positions";
}

export interface ProgressiveLayoutCompleteMessage {
	run: number;
	type: "complete";
}

export type ProgressiveLayoutWorkerMessage = ProgressiveLayoutPositionsMessage | ProgressiveLayoutCompleteMessage;

/** Packs `node-N` edge endpoints into a transferable index buffer for the force worker. */
export function packIndexedForceEdges(edges: readonly { source: string; target: string }[]): Uint32Array {
	const result = new Uint32Array(edges.length * 2);
	for (const [index, edge] of edges.entries()) {
		result[index * 2] = Number(edge.source.slice(5));
		result[index * 2 + 1] = Number(edge.target.slice(5));
	}
	return result;
}

/** Matches playground auto batching: larger graphs stream fewer, bigger transferable batches. */
export function progressiveForceBatchSize(nodeCount: number): number {
	return Math.max(1_000, Math.ceil(nodeCount / 8));
}

/**
 * Aggregates host-side progressive layout phases. Callers supply wall-clock stamps so
 * unit tests can drive the sequence without a real worker.
 */
export class ProgressiveLayoutTimer {
	private batchCount = 0;
	private computeMilliseconds = 0;
	private computeRecorded = false;
	private phases: MultilevelPhaseTiming | undefined;
	private firstUsefulFrameMilliseconds: number | undefined;
	private startedAt = 0;
	private startupMilliseconds = 0;
	private transferMilliseconds = 0;

	constructor(
		private readonly nodeCount: number,
		private readonly batchSize: number,
		private readonly iterations: number,
	) {}

	markStart(now: number) {
		this.startedAt = now;
	}

	markStartup(milliseconds: number) {
		this.startupMilliseconds = milliseconds;
	}

	markTransfer(milliseconds: number) {
		this.transferMilliseconds = milliseconds;
	}

	recordAppliedBatch(now: number, computeMilliseconds?: number, phases?: MultilevelPhaseTiming) {
		this.batchCount += 1;
		if (!this.computeRecorded && typeof computeMilliseconds === "number") {
			this.computeMilliseconds = computeMilliseconds;
			this.computeRecorded = true;
		}
		this.phases ??= phases;
		if (this.firstUsefulFrameMilliseconds === undefined) {
			this.firstUsefulFrameMilliseconds = now - this.startedAt;
		}
	}

	complete(now: number): ProgressiveLayoutTiming {
		if (this.firstUsefulFrameMilliseconds === undefined) {
			throw new Error("Progressive layout completed without a useful position batch.");
		}
		return {
			batchCount: this.batchCount,
			batchSize: this.batchSize,
			completeMilliseconds: now - this.startedAt,
			computeMilliseconds: this.computeMilliseconds,
			firstUsefulFrameMilliseconds: this.firstUsefulFrameMilliseconds,
			iterations: this.iterations,
			kind: "force",
			nodeCount: this.nodeCount,
			...(this.phases === undefined ? {} : { phases: this.phases }),
			startupMilliseconds: this.startupMilliseconds,
			transferMilliseconds: this.transferMilliseconds,
		};
	}
}

export async function measureProgressiveForceLayout(options: {
	applyLayout: (layout: { nodeIds: string[]; positions: Float32Array }) => void;
	batchSize?: number;
	/** `"multilevel"` runs the multilevel force layout in the worker (see `layout-worker.ts`). Omitted: the plain force layout. */
	algorithm?: "classic" | "multilevel";
	createWorker: () => Worker;
	dimensions: 2 | 3;
	edges: readonly { source: string; target: string }[];
	iterations?: number;
	nextFrame: () => Promise<unknown>;
	nodeCount: number;
	now?: () => number;
	settings?: ForceSettings;
}): Promise<ProgressiveLayoutTiming> {
	const now = options.now ?? (() => performance.now());
	const batchSize = options.batchSize ?? progressiveForceBatchSize(options.nodeCount);
	const iterations = options.iterations ?? forceIterationCount(options.nodeCount);
	const settings = options.settings ?? DEFAULT_FORCE_SETTINGS;
	const timer = new ProgressiveLayoutTimer(options.nodeCount, batchSize, iterations);
	const run = 1;

	timer.markStart(now());
	const startupStartedAt = now();
	const worker = options.createWorker();
	timer.markStartup(now() - startupStartedAt);

	const transferStartedAt = now();
	const packedEdges = packIndexedForceEdges(options.edges);
	worker.postMessage(
		{
			algorithm: options.algorithm,
			batchSize,
			dimensions: options.dimensions,
			edges: packedEdges,
			iterations,
			layout: "force",
			maxFps: 30,
			nodeCount: options.nodeCount,
			run,
			settings,
			type: "start",
		},
		[packedEdges.buffer],
	);
	timer.markTransfer(now() - transferStartedAt);

	return await new Promise<ProgressiveLayoutTiming>((resolve, reject) => {
		const onMessage = (event: MessageEvent<ProgressiveLayoutWorkerMessage>) => {
			const data = event.data;
			if (data.run !== run) return;
			void (async () => {
				try {
					if (data.type === "positions") {
						const start = data.end - data.positions.length / 3;
						const nodeIds = Array.from({ length: data.positions.length / 3 }, (_, index) => `node-${start + index}`);
						options.applyLayout({ nodeIds, positions: data.positions });
						await options.nextFrame();
						timer.recordAppliedBatch(now(), data.computeMilliseconds, data.phases);
						worker.postMessage({ run, type: "next" });
						return;
					}
					worker.removeEventListener("message", onMessage);
					worker.terminate();
					resolve(timer.complete(now()));
				} catch (error) {
					worker.removeEventListener("message", onMessage);
					worker.terminate();
					reject(error);
				}
			})();
		};
		worker.addEventListener("message", onMessage);
	});
}

/** Largest fixture the Prove run checks for seed stability: the measurement is O(seeds * nodeCount^2). */
export const STABILITY_SAMPLE_NODES = 1_000;

export interface FixtureLayoutStability {
	nodeCount: number;
	neighbours: number;
	/** Stability of the fixture's layout across seeds, from 0 to 1. */
	overall: number;
	/** The same number for a degree-preserving shuffle of the fixture: the floor a layout gets for free. */
	placeboOverall: number;
	seeds: number;
}

/**
 * Seed stability of the one-shot `"edge-t"` layout on the first {@link STABILITY_SAMPLE_NODES} nodes of a
 * fixture, as one cluster (the fixture has no planted groups). Edges that leave the sample are dropped.
 */
export function measureFixtureLayoutStability(
	nodeCount: number,
	edges: readonly { source: string; target: string }[],
): FixtureLayoutStability {
	const sampleCount = Math.min(nodeCount, STABILITY_SAMPLE_NODES);
	const sampled = packIndexedForceEdges(edges).filter((_, index, all) => {
		const pair = index - (index % 2);
		return (all[pair] ?? 0) < sampleCount && (all[pair + 1] ?? 0) < sampleCount;
	});
	const result: LayoutStability = measureLayoutStability(
		{
			clusters: new Uint32Array(sampleCount),
			dimensions: 3,
			edges: sampled,
			nodeCount: sampleCount,
			settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle: "edge-t" },
		},
		{ neighbours: Math.min(10, sampleCount - 1) },
	);
	return {
		neighbours: result.neighbours,
		nodeCount: sampleCount,
		overall: result.overall,
		placeboOverall: result.placeboOverall ?? 0,
		seeds: result.seeds,
	};
}
