import { computeForcePositions, createForceSimulation, type ForceSettings } from "../../../src/force-layout";
import { normalizeExtent, spreadClusters } from "./stress-layout";

type LayoutName = "circle" | "force" | "force-live" | "grid";

type LayoutRequest = {
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
	activeLayout.computeMilliseconds = undefined;
	workerScope.postMessage(
		{
			end,
			positions,
			run,
			type: "positions",
			...(computeMilliseconds === undefined ? {} : { computeMilliseconds }),
		},
		[positions.buffer],
	);
}

workerScope.addEventListener("message", ({ data }) => {
	if (data.type === "start") {
		stopLiveLayout();
		if (data.layout === "force-live") {
			startLiveLayout(data);
			return;
		}
		let computeMilliseconds: number | undefined;
		let positions: Float32Array | undefined;
		if (data.layout === "force") {
			const computeStartedAt = performance.now();
			positions = computeForcePositions({
				clusters: data.clusters,
				dimensions: data.dimensions,
				edges: data.edges ?? new Uint32Array(),
				initialPositions: data.initialPositions,
				iterations: data.iterations,
				nodeCount: data.nodeCount,
				settings: data.settings,
				warmStart: data.warmStart,
			});
			if (data.clusters) normalizeExtent(spreadClusters(positions, data.clusters), data.nodeCount);
			computeMilliseconds = performance.now() - computeStartedAt;
		}
		activeLayout = {
			computeMilliseconds,
			nextStart: 0,
			positions,
			request: data,
		};
		postNextBatch(data.run);
		return;
	}
	postNextBatch(data.run);
});
