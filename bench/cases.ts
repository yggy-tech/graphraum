import { BENCHMARK_NODE_COLORS, createFixture } from "../docs/src/lib/benchmark";
import { measureProgressiveForceLayout } from "../docs/src/lib/layout-benchmark";
import { Graphraum, type GraphraumData, type GraphraumMode, type GraphraumThemeName } from "../src";
import { attachClusterLod, buildClusterTree, nodeColorKeys, openClusterLod } from "../src/lod";
import { MAX_PIXEL_RATIO, nextFrame, sampleFrames } from "./measure";
import { LOD_INSTANT_SIZES, LOD_SCALING_SIZES, SCALING_SIZES, scalingCaseId } from "./scaling";
import type { CaseDescriptor, CaseRunResult } from "./types";

export interface BenchCase {
	descriptor: CaseDescriptor;
	run(container: HTMLElement): Promise<CaseRunResult>;
}

const WARMUP_FRAMES = 20;

function frameCount(nodes: number) {
	return nodes >= 100_000 ? 60 : 120;
}

/** A mounted graph plus its cold costs: fixture, construction, setData and the first frame. */
async function mount(container: HTMLElement, mode: GraphraumMode, data: GraphraumData, fixtureMs: number) {
	await nextFrame();
	const constructionStartedAt = performance.now();
	const graph = new Graphraum(container, { maxPixelRatio: MAX_PIXEL_RATIO, mode });
	const constructMs = performance.now() - constructionStartedAt;
	const setDataStartedAt = performance.now();
	graph.setData(data);
	const setDataMs = performance.now() - setDataStartedAt;
	const firstFrameStartedAt = performance.now();
	await nextFrame();
	const firstFrameMs = performance.now() - firstFrameStartedAt;
	const cold = {
		constructMs,
		firstFrameCpuMs: graph.getDiagnostics().cpuFrameMilliseconds,
		firstFrameMs,
		fixtureMs,
		setDataMs,
	};
	return { cold, graph };
}

function fixtureWithGlow(nodes: number, glowNodes: number): { data: GraphraumData; fixtureMs: number } {
	const startedAt = performance.now();
	const data = createFixture(nodes);
	return {
		data: { ...data, nodes: data.nodes.map((node, index) => (index < glowNodes ? { ...node, glow: 1 } : node)) },
		fixtureMs: performance.now() - startedAt,
	};
}

function plainFixture(nodes: number) {
	const startedAt = performance.now();
	const data = createFixture(nodes);
	return { data, fixtureMs: performance.now() - startedAt };
}

/** Pan and zoom together: the view breathes between the fitted height and a sixth of it while the centre drifts. */
function panZoom2d(graph: Graphraum) {
	const base = graph.getCameraState();
	if (base.mode !== "2d") throw new Error("Pan/zoom benchmark needs a 2D camera.");
	return (index: number) => {
		const phase = index / 40;
		const visibleHeight = base.visibleHeight * (0.58 + 0.42 * Math.cos(phase * Math.PI * 2));
		graph.setCameraState({
			center: {
				x: base.center.x + Math.sin(phase * Math.PI * 2) * base.visibleHeight * 0.35,
				y: base.center.y + Math.cos(phase * Math.PI * 1.3) * base.visibleHeight * 0.2,
			},
			mode: "2d",
			visibleHeight,
		});
	};
}

/** The 3D camera sweeps around the target at a changing distance, so culling-independent cost shows up per frame. */
function orbit3d(graph: Graphraum) {
	const base = graph.getCameraState();
	if (base.mode !== "3d") throw new Error("Orbit benchmark needs a 3D camera.");
	const dx = base.position.x - base.target.x;
	const dy = base.position.y - base.target.y;
	const dz = base.position.z - base.target.z;
	const radius = Math.hypot(dx, dz);
	const start = Math.atan2(dz, dx);
	return (index: number) => {
		const angle = start + (index / 240) * Math.PI * 2;
		graph.setCameraState({
			mode: "3d",
			position: {
				x: base.target.x + Math.cos(angle) * radius,
				y: base.target.y + dy,
				z: base.target.z + Math.sin(angle) * radius,
			},
			target: base.target,
		});
	};
}

function frameCase(mode: GraphraumMode, nodes: number): BenchCase {
	const label = mode === "2d" ? "Pan and zoom" : "Orbit camera";
	return {
		descriptor: {
			edges: nodes * 3,
			group: "frame",
			id: `frame-${mode}-${nodes}`,
			mode,
			nodes,
			protocol: `${WARMUP_FRAMES} warm-up frames, then ${frameCount(nodes)} frames; each frame moves the camera with setCameraState() and renders once, so the step column includes viewport materialization.`,
			title: `${label} ${nodes.toLocaleString("en-US")}`,
		},
		async run(container) {
			const { data, fixtureMs } = plainFixture(nodes);
			const { cold, graph } = await mount(container, mode, data, fixtureMs);
			graph.fitView();
			await nextFrame();
			const drive = mode === "2d" ? panZoom2d(graph) : orbit3d(graph);
			await sampleFrames(graph, WARMUP_FRAMES, drive);
			const warm = await sampleFrames(graph, frameCount(nodes), (index) => drive(index + WARMUP_FRAMES));
			graph.destroy();
			return { cold, warm };
		},
	};
}

function autoOrbitCase(nodes: number): BenchCase {
	return {
		descriptor: {
			edges: nodes * 3,
			group: "orbit",
			id: `orbit-3d-${nodes}`,
			mode: "3d",
			nodes,
			protocol: `setAutoOrbit({ speed: 0.5 }); ${WARMUP_FRAMES} warm-up frames, then ${frameCount(nodes)} frames driven by the orbit loop itself (no per-frame calls from the benchmark).`,
			title: `Auto-orbit ${nodes.toLocaleString("en-US")}`,
		},
		async run(container) {
			const { data, fixtureMs } = plainFixture(nodes);
			const { cold, graph } = await mount(container, "3d", data, fixtureMs);
			graph.fitView();
			graph.setAutoOrbit({ speed: 0.5 });
			await sampleFrames(graph, WARMUP_FRAMES, null);
			const status = graph.getDiagnostics().autoOrbit;
			if (status !== "active")
				throw new Error(`Auto-orbit is "${status}", not active; the orbit loop cannot be measured.`);
			const warm = await sampleFrames(graph, frameCount(nodes), null);
			graph.destroy();
			return { cold, warm };
		},
	};
}

function selectionCase(nodes: number): BenchCase {
	return {
		descriptor: {
			edges: nodes * 3,
			group: "selection",
			id: `selection-2d-${nodes}`,
			mode: "2d",
			nodes,
			protocol: `${WARMUP_FRAMES} warm-up frames, then ${frameCount(nodes)} frames; each frame selects a different node with setSelection().`,
			title: `setSelection ${nodes.toLocaleString("en-US")}`,
		},
		async run(container) {
			const { data, fixtureMs } = plainFixture(nodes);
			const { cold, graph } = await mount(container, "2d", data, fixtureMs);
			graph.fitView();
			const select = (index: number) => graph.setSelection([`node-${(index * 7919) % nodes}`]);
			await sampleFrames(graph, WARMUP_FRAMES, select);
			const warm = await sampleFrames(graph, frameCount(nodes), (index) => select(index + WARMUP_FRAMES));
			graph.destroy();
			return { cold, warm };
		},
	};
}

function edgeHoverCase(nodes: number): BenchCase {
	const edges = nodes * 3;
	return {
		descriptor: {
			edges,
			group: "selection",
			id: `edge-hover-2d-${nodes}`,
			mode: "2d",
			nodes,
			protocol: `${WARMUP_FRAMES} warm-up frames, then ${frameCount(nodes)} frames; each frame highlights a different edge with setEdgeSelection(), as a hover would.`,
			title: `setEdgeSelection hover ${nodes.toLocaleString("en-US")}`,
		},
		async run(container) {
			const { data, fixtureMs } = plainFixture(nodes);
			const { cold, graph } = await mount(container, "2d", data, fixtureMs);
			graph.fitView();
			const hover = (index: number) => graph.setEdgeSelection([`edge-${(index * 7919) % edges}`]);
			await sampleFrames(graph, WARMUP_FRAMES, hover);
			const warm = await sampleFrames(graph, frameCount(nodes), (index) => hover(index + WARMUP_FRAMES));
			graph.destroy();
			return { cold, warm };
		},
	};
}

const GLOW_FIXTURE_NODES = 2_000;

function glowCase(glowNodes: number, theme: GraphraumThemeName, mode: GraphraumMode): BenchCase {
	return {
		descriptor: {
			edges: GLOW_FIXTURE_NODES * 3,
			group: "glow",
			id: `glow-${mode}-${theme}-${glowNodes}`,
			mode,
			nodes: GLOW_FIXTURE_NODES,
			protocol: `${glowNodes} nodes with glow 1, ${theme} theme; ${WARMUP_FRAMES} warm-up frames, then ${frameCount(GLOW_FIXTURE_NODES)} camera-move frames (2D pan/zoom, 3D orbit).`,
			title: `Glow ${glowNodes} ${theme} ${mode.toUpperCase()}`,
		},
		async run(container) {
			const { data, fixtureMs } = fixtureWithGlow(GLOW_FIXTURE_NODES, glowNodes);
			const { cold, graph } = await mount(container, mode, data, fixtureMs);
			graph.setTheme(theme);
			graph.fitView();
			await nextFrame();
			const drive = mode === "2d" ? panZoom2d(graph) : orbit3d(graph);
			await sampleFrames(graph, WARMUP_FRAMES, drive);
			const warm = await sampleFrames(graph, frameCount(GLOW_FIXTURE_NODES), (index) => drive(index + WARMUP_FRAMES));
			graph.destroy();
			return { cold, warm };
		},
	};
}

const MULTILEVEL_PROTOCOL =
	" With the multilevel algorithm the worker coarsens the graph, lays out the coarsest level, posts a rough preview of the whole graph (the first useful frame) and refines the finer levels; coarsen, coarsest and refine are the worker's own time in those phases.";

function layoutCase(nodes: number, algorithm: "classic" | "multilevel" = "classic"): BenchCase {
	const multilevel = algorithm === "multilevel";
	return {
		descriptor: {
			edges: nodes * 3,
			group: "layout",
			id: `layout-${multilevel ? "multilevel-" : ""}3d-${nodes}`,
			mode: "3d",
			nodes,
			protocol:
				"One force layout in the docs layout worker, streamed back in batches and applied to a mounted graph. Startup is Worker construction on the main thread, transfer is packing and posting the edge buffer, compute is the worker's own solve time, first useful frame is start to the first applied batch, total is start to the last batch." +
				(multilevel ? MULTILEVEL_PROTOCOL : ""),
			title: `Worker ${multilevel ? "multilevel " : ""}force layout ${nodes.toLocaleString("en-US")}`,
		},
		async run(container) {
			const { data, fixtureMs } = plainFixture(nodes);
			const { cold, graph } = await mount(container, "3d", data, fixtureMs);
			const timing = await measureProgressiveForceLayout({
				algorithm,
				applyLayout: (positions) => graph.applyLayout(positions),
				createWorker: () =>
					new Worker(new URL("../docs/src/lib/layout-worker.ts", import.meta.url), { type: "module" }),
				dimensions: 3,
				edges: data.edges,
				nextFrame,
				nodeCount: nodes,
			});
			graph.destroy();
			return {
				cold: {
					...cold,
					batchCount: timing.batchCount,
					...(timing.phases
						? {
								coarsenMs: timing.phases.coarsenMs,
								coarsestMs: timing.phases.coarsestMs,
								levels: timing.phases.levels,
								refineMs: timing.phases.refineMs,
							}
						: {}),
					computeMs: timing.computeMilliseconds,
					firstUsefulFrameMs: timing.firstUsefulFrameMilliseconds,
					iterations: timing.iterations,
					startupMs: timing.startupMilliseconds,
					totalMs: timing.completeMilliseconds,
					transferMs: timing.transferMilliseconds,
				},
				warm: {},
			};
		},
	};
}

/** Pan only: the view stays at a quarter of the fitted height and drifts across the graph. */
function pan2d(graph: Graphraum) {
	const base = graph.getCameraState();
	if (base.mode !== "2d") throw new Error("Pan benchmark needs a 2D camera.");
	return (index: number) => {
		const phase = index / 60;
		graph.setCameraState({
			center: {
				x: base.center.x + Math.sin(phase * Math.PI * 2) * base.visibleHeight * 0.4,
				y: base.center.y + Math.cos(phase * Math.PI * 2) * base.visibleHeight * 0.2,
			},
			mode: "2d",
			visibleHeight: base.visibleHeight * 0.25,
		});
	};
}

/** Zoom only: the centre stays put while the height breathes between the fitted height and a twentieth of it. */
function zoom2d(graph: Graphraum) {
	const base = graph.getCameraState();
	if (base.mode !== "2d") throw new Error("Zoom benchmark needs a 2D camera.");
	return (index: number) => {
		const phase = index / 60;
		graph.setCameraState({
			center: base.center,
			mode: "2d",
			visibleHeight: base.visibleHeight * (0.525 + 0.475 * Math.cos(phase * Math.PI * 2)),
		});
	};
}

function scalingDescriptor(
	series: string,
	nodes: number,
	mode: GraphraumMode,
	protocol: string,
	title: string,
): CaseDescriptor {
	return {
		edges: nodes * 3,
		group: "scaling",
		id: scalingCaseId(series, nodes),
		mode,
		nodes,
		protocol,
		scalingSeries: series,
		title: `${title} ${nodes.toLocaleString("en-US")}`,
	};
}

/** Frame-driven ladder case: a fresh page per size, camera or selection driven for `frameCount(nodes)` frames. */
function scalingFrameCase(
	series: string,
	mode: GraphraumMode,
	title: string,
	protocol: string,
	nodes: number,
	driverFor: (graph: Graphraum, nodes: number) => ((index: number) => void) | null,
): BenchCase {
	return {
		descriptor: scalingDescriptor(series, nodes, mode, protocol, title),
		async run(container) {
			const { data, fixtureMs } = plainFixture(nodes);
			const { cold, graph } = await mount(container, mode, data, fixtureMs);
			graph.fitView();
			if (mode === "3d" && series === "orbit3d") graph.setAutoOrbit({ speed: 0.5 });
			await nextFrame();
			const drive = driverFor(graph, nodes);
			await sampleFrames(graph, WARMUP_FRAMES, drive);
			const warm = await sampleFrames(graph, frameCount(nodes), drive ? (index) => drive(index + WARMUP_FRAMES) : null);
			graph.destroy();
			return { cold, warm };
		},
	};
}

function scalingLoadCase(nodes: number): BenchCase {
	return {
		descriptor: scalingDescriptor(
			"load",
			nodes,
			"2d",
			"Fresh page: fixture, construction, setData, then the first frame. loadMs is setData plus the first frame.",
			"Data load",
		),
		async run(container) {
			const { data, fixtureMs } = plainFixture(nodes);
			const { cold, graph } = await mount(container, "2d", data, fixtureMs);
			graph.destroy();
			return { cold: { ...cold, loadMs: cold.setDataMs + cold.firstFrameMs }, warm: {} };
		},
	};
}

function scalingLayoutCase(nodes: number, algorithm: "classic" | "multilevel" = "classic"): BenchCase {
	const base = layoutCase(nodes, algorithm);
	const multilevel = algorithm === "multilevel";
	return {
		descriptor: scalingDescriptor(
			multilevel ? "layout-multilevel" : "layout",
			nodes,
			"3d",
			base.descriptor.protocol,
			multilevel ? "Worker multilevel force layout" : "Worker force layout",
		),
		run: base.run,
	};
}

/** Cluster LOD ladder case: build the tree, attach it to a fresh graph, then drive the camera as the plain cases do. */
function lodScalingCase(
	series: "lodinstant2d" | "lodinstant3d" | "lodorbit3d" | "lodpan2d",
	nodes: number,
	animated: boolean,
): BenchCase {
	const mode: GraphraumMode = series.endsWith("2d") ? "2d" : "3d";
	const base = scalingDescriptor(
		series,
		nodes,
		mode,
		`Cluster LOD (4000 nodes, 8000 edges budget, 10 px threshold, colour blends and count labels on, ${animated ? "split and merge animation on" : "animation off"}) over the same fixture as the plain ladder. ${mode === "2d" ? "Camera pans at a quarter of the fitted height." : "The camera orbits the target by setCameraState()."} Each frame's step includes the cut and the data swap.`,
		`${mode === "2d" ? "2D pan" : "3D orbit"}, cluster LOD${animated ? "" : ", no animation"}`,
	);
	return {
		descriptor: base,
		async run(container) {
			const { data, fixtureMs } = plainFixture(nodes);
			await nextFrame();
			const dimensions = mode === "2d" ? 2 : 3;
			const treeStartedAt = performance.now();
			const positions = new Float32Array(nodes * dimensions);
			for (const [index, node] of data.nodes.entries()) {
				positions[index * dimensions] = node.position.x;
				positions[index * dimensions + 1] = node.position.y;
				if (dimensions === 3) positions[index * 3 + 2] = node.position.z ?? 0;
			}
			const edges = new Uint32Array(data.edges.length * 2);
			for (let edge = 0; edge < data.edges.length; edge += 1) {
				edges[edge * 2] = edge % nodes;
				edges[edge * 2 + 1] = (edge * 97 + 13) % nodes;
			}
			const tree = buildClusterTree({ colors: nodeColorKeys(data.nodes), dimensions, edges, positions });
			const treeBuildMs = performance.now() - treeStartedAt;
			const constructionStartedAt = performance.now();
			const graph = new Graphraum(container, { maxPixelRatio: MAX_PIXEL_RATIO, mode });
			const constructMs = performance.now() - constructionStartedAt;
			const attachStartedAt = performance.now();
			const lod = attachClusterLod(graph, tree, {
				data,
				element: container,
				prefersReducedMotion: () => false,
				transitionMilliseconds: animated ? 200 : 0,
			});
			const attachMs = performance.now() - attachStartedAt;
			const firstFrameStartedAt = performance.now();
			await nextFrame();
			const cold = {
				attachMs,
				constructMs,
				firstFrameMs: performance.now() - firstFrameStartedAt,
				fixtureMs,
				treeBuildMs,
			};
			await nextFrame();
			const drive = mode === "2d" ? pan2d(graph) : orbit3d(graph);
			await sampleFrames(graph, WARMUP_FRAMES, drive);
			const warm = await sampleFrames(graph, frameCount(nodes), (index) => drive(index + WARMUP_FRAMES));
			const drawn = lod.getDiagnostics();
			lod.detach();
			graph.destroy();
			return {
				cold: {
					...cold,
					drawnAggregates: drawn.drawnAggregates,
					drawnEdges: drawn.drawnEdges,
					drawnNodes: drawn.drawnNodes,
				},
				warm,
			};
		},
	};
}

/** The ladder fixture as typed arrays only (same grid, colours and edges as `createFixture`), so 5M nodes never become objects. */
function typedFixture(nodes: number, dimensions: 2 | 3) {
	const columns = Math.ceil(Math.sqrt(nodes));
	const palette = nodeColorKeys(BENCHMARK_NODE_COLORS.map((color) => ({ color })));
	const positions = new Float32Array(nodes * dimensions);
	const colors = new Uint32Array(nodes);
	for (let index = 0; index < nodes; index += 1) {
		const row = Math.floor(index / columns);
		positions[index * dimensions] = (index % columns) * 12;
		positions[index * dimensions + 1] = row * 12;
		if (dimensions === 3) positions[index * 3 + 2] = ((index * 17) % 101) - 50;
		colors[index] = palette[(index * 7 + row * 3) % palette.length] as number;
	}
	const edges = new Uint32Array(nodes * 6);
	for (let edge = 0; edge < nodes * 3; edge += 1) {
		edges[edge * 2] = edge % nodes;
		edges[edge * 2 + 1] = (edge * 97 + 13) % nodes;
	}
	return { colors, dimensions, edges, positions };
}

const heapMegabytes = () => {
	const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
	return memory ? memory.usedJSHeapSize / 1_048_576 : null;
};

/** LOD first load: typed arrays straight into the cluster view, the tree built in a worker, no plain setData of the graph. */
function lodFirstLoadCase(series: "lodfirst2d" | "lodfirst3d", nodes: number): BenchCase {
	const mode: GraphraumMode = series.endsWith("2d") ? "2d" : "3d";
	return {
		descriptor: scalingDescriptor(
			series,
			nodes,
			mode,
			"Fresh page, typed-array fixture (not timed). openClusterLod() builds the tree in a module worker and draws the cut: firstFrameMs is the call until the first LOD frame after the coarse tree, completeMs until the aggregate edges are drawn, workerBuildMs the worker's own build time (clusters plus edges). peakHeapMb is the highest main-thread JS heap sampled every 25 ms (typed arrays are outside it); maxFrameGapMs is the longest gap between frames while opening.",
			`LOD first load, ${mode === "2d" ? "2D" : "3D"}`,
		),
		async run(container) {
			const fixtureStartedAt = performance.now();
			const input = typedFixture(nodes, mode === "2d" ? 2 : 3);
			const fixtureMs = performance.now() - fixtureStartedAt;
			await nextFrame();
			const heapBefore = heapMegabytes();
			let peakHeap = heapBefore ?? 0;
			const sampler = setInterval(() => {
				peakHeap = Math.max(peakHeap, heapMegabytes() ?? 0);
			}, 25);
			let maxGap = 0;
			let watching = true;
			let previous = performance.now();
			const watch = () => {
				const now = performance.now();
				maxGap = Math.max(maxGap, now - previous);
				previous = now;
				if (watching) requestAnimationFrame(watch);
			};
			requestAnimationFrame(watch);
			const constructionStartedAt = performance.now();
			const graph = new Graphraum(container, { maxPixelRatio: MAX_PIXEL_RATIO, mode });
			const constructMs = performance.now() - constructionStartedAt;
			const startedAt = performance.now();
			const lod = await openClusterLod(graph, input, {
				createWorker: () => new Worker(new URL("../src/lod-worker.ts", import.meta.url), { type: "module" }),
				element: container,
				prefersReducedMotion: () => false,
			});
			await nextFrame();
			const firstFrameMs = performance.now() - startedAt;
			const firstHeap = heapMegabytes();
			await lod.complete;
			await nextFrame();
			watching = false;
			clearInterval(sampler);
			const timings = lod.getTimings();
			const drawn = lod.getDiagnostics();
			const finalHeap = heapMegabytes();
			lod.detach();
			graph.destroy();
			return {
				cold: {
					completeMs: timings.completeMilliseconds,
					constructMs,
					drawnAggregates: drawn.drawnAggregates,
					drawnEdges: drawn.drawnEdges,
					drawnNodes: drawn.drawnNodes,
					firstCutMs: timings.firstCutMilliseconds,
					firstFrameMs,
					fixtureMs,
					heapAfterFirstFrameMb: firstHeap,
					heapFinalMb: finalHeap,
					maxFrameGapMs: maxGap,
					peakHeapMb: heapBefore === null ? null : peakHeap,
					workerBuildMs: timings.buildCoarseMilliseconds + (timings.buildEdgesMilliseconds ?? 0),
					workerCoarseMs: timings.buildCoarseMilliseconds,
					workerEdgesMs: timings.buildEdgesMilliseconds,
				},
				warm: {},
			};
		},
	};
}

const lodCases: readonly BenchCase[] = [
	...LOD_SCALING_SIZES.flatMap((nodes) => [
		lodFirstLoadCase("lodfirst2d", nodes),
		lodFirstLoadCase("lodfirst3d", nodes),
	]),
	...LOD_SCALING_SIZES.flatMap((nodes) => [
		lodScalingCase("lodpan2d", nodes, true),
		lodScalingCase("lodorbit3d", nodes, true),
	]),
	...LOD_INSTANT_SIZES.flatMap((nodes) => [
		lodScalingCase("lodinstant2d", nodes, false),
		lodScalingCase("lodinstant3d", nodes, false),
	]),
];

const scalingCases: readonly BenchCase[] = SCALING_SIZES.flatMap((nodes) => [
	scalingFrameCase("pan2d", "2d", "2D pan", "Camera pans at a quarter of the fitted height.", nodes, panDriver),
	scalingFrameCase(
		"zoom2d",
		"2d",
		"2D zoom",
		"Camera zooms between the fitted height and a twentieth of it.",
		nodes,
		zoomDriver,
	),
	scalingFrameCase(
		"orbit3d",
		"3d",
		"3D orbit",
		"The orbit loop renders by itself; CPU and GPU time come from the renderer.",
		nodes,
		() => null,
	),
	scalingFrameCase("selection2d", "2d", "Selection", "Each frame selects a different node.", nodes, selectDriver),
	scalingLoadCase(nodes),
	scalingLayoutCase(nodes),
	scalingLayoutCase(nodes, "multilevel"),
]);

function panDriver(graph: Graphraum) {
	return pan2d(graph);
}

function zoomDriver(graph: Graphraum) {
	return zoom2d(graph);
}

function selectDriver(graph: Graphraum, nodes: number) {
	return (index: number) => graph.setSelection([`node-${(index * 7919) % nodes}`]);
}

/** Cheapest case; the runner loads it once first so the dev server has transformed every module. */
const warmupCase: BenchCase = {
	descriptor: {
		edges: 600,
		group: "frame",
		id: "warmup",
		mode: "3d",
		nodes: 200,
		protocol: "Warms the dev server; never reported.",
		title: "Warm-up",
	},
	async run(container) {
		const { data, fixtureMs } = plainFixture(200);
		const { cold, graph } = await mount(container, "3d", data, fixtureMs);
		const warm = await sampleFrames(graph, 5, null);
		graph.destroy();
		await measureProgressiveForceLayout({
			applyLayout: () => {},
			createWorker: () => new Worker(new URL("../docs/src/lib/layout-worker.ts", import.meta.url), { type: "module" }),
			dimensions: 3,
			edges: data.edges,
			nextFrame,
			nodeCount: 200,
		});
		return { cold, warm };
	},
};

/** The whole suite. Sizes follow #138 (10k and 100k nodes), #147 (layout) and #122 (orbit, glow, edge hover). */
export const BENCH_CASES: readonly BenchCase[] = [
	frameCase("2d", 10_000),
	frameCase("2d", 100_000),
	frameCase("3d", 10_000),
	frameCase("3d", 100_000),
	selectionCase(10_000),
	selectionCase(100_000),
	layoutCase(10_000),
	layoutCase(100_000),
	autoOrbitCase(2_000),
	autoOrbitCase(10_000),
	...([14, 256] as const).flatMap((glowNodes) =>
		(["light", "dark"] as const).flatMap((theme) =>
			(["2d", "3d"] as const).map((mode) => glowCase(glowNodes, theme, mode)),
		),
	),
	edgeHoverCase(2_000),
	edgeHoverCase(10_000),
	...scalingCases,
	...lodCases,
];

export function findCase(id: string): BenchCase | undefined {
	return id === "warmup" ? warmupCase : BENCH_CASES.find((benchCase) => benchCase.descriptor.id === id);
}
