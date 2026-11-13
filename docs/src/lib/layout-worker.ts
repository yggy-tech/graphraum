import { computeForcePositions, createForceSimulation, type ForceSettings } from "../../../src/force-layout";
import { computeMultilevelForcePositionsAsync, type ParallelMultilevelOptions } from "../../../src/layout-multilevel";
import { normalizeExtent, spreadClusters } from "./stress-layout";

/** Where a multilevel layout spent its time, in milliseconds, and how many coarse levels it built. */
type MultilevelPhases = { coarsenMs: number; coarsestMs: number; levels: number; refineMs: number };

type LayoutName = "circle" | "force" | "force-live" | "grid";

type LayoutRequest = {
	/** `"multilevel"` solves the force layout on coarsened copies of the graph and posts a rough preview first. Omitted: `"classic"`, the plain force layout. */
	algorithm?: "classic" | "multilevel";
	batchSize: number;
	/** Community index per node; seeds force nodes around cluster centres. */
	clusters?: Uint32Array;
	dimensions: 2 | 3;
	edges?: Uint32Array;
	/** Start positions (NaN = new node); with `warmStart` the layout settles instead of starting over. */
	initialPositions?: Float32Array;
	iterations?: number;
	layout: LayoutName;
	maxFps: number;
	/** Options of the `"multilevel"` algorithm. */
	multilevel?: ParallelMultilevelOptions;
	nodeCount: number;
	run: number;
	settings: ForceSettings;
	warmStart?: boolean;
};

type LayoutWorkerMessage = ({ type: "start" } & LayoutRequest) | { run: number; type: "next" };

type WorkerScope = {
	addEventListener(type: "message", listener: (event: MessageEvent<LayoutWorkerMessage>) => void): void;
	postMessage(message: unknown, transfer: Transferable[]): void;
};

const workerScope = self as unknown as WorkerScope;
let activeLayout:
	| {
			computeMilliseconds?: number;
			nextStart: number;
			phases?: MultilevelPhases;
			positions?: Float32Array;
			request: LayoutRequest;
			timer?: ReturnType<typeof setTimeout>;
	  }
	| undefined;

function stopLiveLayout() {
	if (activeLayout?.timer !== undefined) clearTimeout(activeLayout.timer);
}

function startLiveLayout(request: LayoutRequest) {
	const simulation = createForceSimulation({
		clusters: request.clusters,
		dimensions: request.dimensions,
		edges: request.edges ?? new Uint32Array(),
		initialPositions: request.initialPositions,
		nodeCount: request.nodeCount,
		settings: request.settings,
		warmStart: request.warmStart,
	});
	const state: NonNullable<typeof activeLayout> = { nextStart: 0, request };
	activeLayout = state;
	const tick = () => {
		if (activeLayout !== state) return;
		simulation.step(request.warmStart ? 0.05 : 0.35);
		const positions = simulation.positions.slice();
		workerScope.postMessage({ end: request.nodeCount, positions, run: request.run, type: "positions" }, [
			positions.buffer,
		]);
		state.timer = setTimeout(tick, Math.max(1, Math.round(1_000 / request.maxFps)));
	};
	tick();
}

function positionsFor(request: LayoutRequest, start: number, end: number) {
	const positions = new Float32Array((end - start) * 3);
	const columns = Math.ceil(Math.sqrt(request.nodeCount));
	const radius = Math.max(Math.sqrt(request.nodeCount) * 6, 24);
	for (let index = start; index < end; index += 1) {
		const offset = (index - start) * 3;
		if (request.layout === "circle") {
			const angle = (index / request.nodeCount) * Math.PI * 2;
			positions.set([Math.cos(angle) * radius, Math.sin(angle) * radius, 0], offset);
			continue;
		}
		positions.set([(index % columns) * 12, Math.floor(index / columns) * 12, ((index * 17) % 101) - 50], offset);
	}
	return positions;
}

function postNextBatch(run: number) {
	if (!activeLayout || activeLayout.request.run !== run) return;
	if (activeLayout.nextStart === activeLayout.request.nodeCount) {
		activeLayout = undefined;
		workerScope.postMessage({ run, type: "complete" }, []);
		return;
	}
	const start = activeLayout.nextStart;
	const end = Math.min(start + activeLayout.request.batchSize, activeLayout.request.nodeCount);
	const positions = activeLayout.positions
		? activeLayout.positions.slice(start * 3, end * 3)
		: positionsFor(activeLayout.request, start, end);
	activeLayout.nextStart = end;
	const computeMilliseconds = activeLayout.computeMilliseconds;
	const phases = activeLayout.phases;
	activeLayout.computeMilliseconds = undefined;
	activeLayout.phases = undefined;
	workerScope.postMessage(
		{
			end,
			positions,
			run,
			type: "positions",
			...(computeMilliseconds === undefined ? {} : { computeMilliseconds }),
			...(phases === undefined ? {} : { phases }),
		},
		[positions.buffer],
	);
}

/** The newest `start`: an older one still computing drops its result. */
let latestRun = 0;

workerScope.addEventListener("message", async ({ data, origin }) => {
	// A dedicated worker only hears the page that started it; its messages carry an empty origin.
	if (origin !== "") return;
	if (data.type === "start") {
		latestRun = data.run;
		stopLiveLayout();
		if (data.layout === "force-live") {
			startLiveLayout(data);
			return;
		}
		let computeMilliseconds: number | undefined;
		let multilevelPhases: MultilevelPhases | undefined;
		let positions: Float32Array | undefined;
		if (data.layout === "force") {
			const computeStartedAt = performance.now();
			const forceRequest = {
				clusters: data.clusters,
				dimensions: data.dimensions,
				edges: data.edges ?? new Uint32Array(),
				initialPositions: data.initialPositions,
				iterations: data.iterations,
				nodeCount: data.nodeCount,
				settings: data.settings,
				warmStart: data.warmStart,
			};
			if (data.algorithm === "multilevel") {
				const phases = { coarsenMs: 0, coarsestMs: 0, levels: 0, refineMs: 0 };
				positions = await computeMultilevelForcePositionsAsync(forceRequest, {
					createWorker: () =>
						new Worker(new URL("../../../src/layout-multilevel-worker.ts", import.meta.url), { type: "module" }),
					...data.multilevel,
					onPreview: (preview) =>
						workerScope.postMessage(
							{ end: data.nodeCount, positions: preview, preview: true, run: data.run, type: "positions" },
							[preview.buffer],
						),
					onProgress: ({ level, milliseconds, phase }) => {
						if (phase === "coarsen") phases.levels = level;
						phases[`${phase}Ms`] += milliseconds;
					},
				});
				multilevelPhases = phases;
			} else positions = computeForcePositions(forceRequest);
			if (latestRun !== data.run) return;
			if (data.clusters) normalizeExtent(spreadClusters(positions, data.clusters), data.nodeCount);
			computeMilliseconds = performance.now() - computeStartedAt;
		}
		activeLayout = {
			computeMilliseconds,
			nextStart: 0,
			phases: multilevelPhases,
			positions,
			request: data,
		};
		postNextBatch(data.run);
		return;
	}
	postNextBatch(data.run);
});
