import { Graphraum, type GraphraumMode } from "@yggy-tech/graphraum";

import { createFixture, effectivePixelRatio, summarize } from "../lib/benchmark";
import { measureProgressiveForceLayout } from "../lib/layout-benchmark";
import type { ProveMeasures } from "../lib/prove-reference";

type MemoryPerformance = Performance & { memory?: { usedJSHeapSize: number } };

export interface ProveRun {
	graph: Graphraum;
	/** Complete result, as copied by "Copy result". */
	json: string;
	measures: ProveMeasures;
}

export interface ProveOptions {
	container: HTMLElement;
	mode: GraphraumMode;
	nodeCount: number;
	/** Called before each phase with a short label and progress from 0 to 1. */
	onPhase: (label: string, progress: number) => void;
}

/** Pixel ratio is fixed at 1 so results compare with the published reference. */
const MAX_PIXEL_RATIO = 1;

function nextFrame() {
	return new Promise<number>((resolve) => requestAnimationFrame(resolve));
}

async function measureFrames(trigger: () => void, count: number) {
	const samples: number[] = [];
	let previous = await nextFrame();
	for (let index = 0; index < count; index += 1) {
		trigger();
		const current = await nextFrame();
		samples.push(current - previous);
		previous = current;
	}
	return samples;
}

/**
 * The Prove protocol: fixture, construction, setData, first frame, display cadence, rendered frames,
 * selection, progressive force layout, a 1% node update and a 1% larger snapshot. The graph stays mounted.
 */
export async function runProve({ container, mode, nodeCount, onPhase }: ProveOptions): Promise<ProveRun> {
	const edgeCount = nodeCount * 3;
	const warmupFrameCount = 10;
	const frameSampleCount = nodeCount >= 100_000 ? 30 : 120;
	const selectionSampleCount = nodeCount >= 100_000 ? 5 : 20;
	const longTasks: number[] = [];
	const observer =
		"PerformanceObserver" in window && PerformanceObserver.supportedEntryTypes.includes("longtask")
			? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)))
			: null;
	observer?.observe({ type: "longtask" });

	onPhase("Building the graph", 0.05);
	await nextFrame();
	const heapBefore = (performance as MemoryPerformance).memory?.usedJSHeapSize;
	const mountedAt = performance.now();
	const data = createFixture(nodeCount);
	const fixtureGenerationMilliseconds = performance.now() - mountedAt;
	await nextFrame();
	const constructionStartedAt = performance.now();
	const graph = new Graphraum(container, { maxPixelRatio: MAX_PIXEL_RATIO, mode });
	const rendererConstructionMilliseconds = performance.now() - constructionStartedAt;
	const setDataStartedAt = performance.now();
	graph.setData(data);
	const setDataMilliseconds = performance.now() - setDataStartedAt;
	const firstFrameStartedAt = performance.now();
	await nextFrame();
	const firstVisibleFrameMilliseconds = performance.now() - firstFrameStartedAt;
	const firstMeaningfulFrameMilliseconds = performance.now() - mountedAt;

	onPhase("Measuring frames", 0.2);
	const displayCadence = summarize(await measureFrames(() => {}, 30));
	await measureFrames(() => graph.render(), warmupFrameCount);
	const frameTimes = summarize(await measureFrames(() => graph.render(), frameSampleCount));

	onPhase("Measuring selection", 0.45);
	const selectionSamples: number[] = [];
	for (let index = 0; index < selectionSampleCount; index += 1) {
		const startedAt = performance.now();
		graph.setSelection([`node-${index % 2}`]);
		await nextFrame();
		selectionSamples.push(performance.now() - startedAt);
	}
	const selectionFeedback = summarize(selectionSamples);

	onPhase("Measuring force layout", 0.55);
	const layout = await measureProgressiveForceLayout({
		applyLayout: (positions) => graph.applyLayout(positions),
		createWorker: () => new Worker(new URL("../lib/layout-worker.ts", import.meta.url), { type: "module" }),
		dimensions: mode === "2d" ? 2 : 3,
		edges: data.edges,
		nextFrame,
		nodeCount,
	});

	onPhase("Measuring updates", 0.85);
	const incrementalNodeCount = Math.max(10, Math.floor(nodeCount * 0.01));
	const incrementalStartedAt = performance.now();
	graph.updateNodes(
		data.nodes.slice(0, incrementalNodeCount).map((node) => ({
			id: node.id,
			position: { ...node.position, x: node.position.x + 0.5 },
		})),
	);
	await nextFrame();
	const incrementalNodeUpdateMilliseconds = performance.now() - incrementalStartedAt;
	const snapshotStartedAt = performance.now();
	graph.setData(createFixture(nodeCount + incrementalNodeCount));
	await nextFrame();
	const updateMilliseconds = performance.now() - snapshotStartedAt;
	await nextFrame();
	observer?.disconnect();
	const heapAfter = (performance as MemoryPerformance).memory?.usedJSHeapSize;
	const diagnostics = graph.getDiagnostics();
	onPhase("Done", 1);

	const payload = {
		approach: "graphraum",
		fixture: { edgeCount, nodeCount },
		protocol: { frameSampleCount, selectionSampleCount, warmupFrameCount },
		mode,
		devicePixelRatio: window.devicePixelRatio,
		maxPixelRatio: MAX_PIXEL_RATIO,
		effectivePixelRatio: effectivePixelRatio(window.devicePixelRatio, MAX_PIXEL_RATIO),
		phases: {
			fixtureGenerationMilliseconds,
			firstVisibleFrameMilliseconds,
			layout,
			rendererConstructionMilliseconds,
			setDataMilliseconds,
		},
		firstMeaningfulFrameMilliseconds,
		displayCadence,
		frameTimes,
		longTasks: summarize(longTasks),
		selectionFeedback,
		incrementalNodeUpdate: { count: incrementalNodeCount, milliseconds: incrementalNodeUpdateMilliseconds },
		heapGrowthBytes: heapBefore === undefined || heapAfter === undefined ? null : heapAfter - heapBefore,
		updateMilliseconds,
		gpuDrawCalls: diagnostics.gpuDrawCalls,
		pickingStrategy: diagnostics.pickingStrategy,
		viewport: {
			lodLevel: diagnostics.lodLevel,
			visibleEdgeCandidates: diagnostics.visibleEdgeCandidates,
			visibleEdges: diagnostics.visibleEdges,
			visibleNodes: diagnostics.visibleNodes,
		},
		userAgent: navigator.userAgent,
		timestamp: new Date().toISOString(),
	};

	return {
		graph,
		json: JSON.stringify(payload, null, 2),
		measures: {
			drawCalls: diagnostics.gpuDrawCalls,
			firstFrame: firstMeaningfulFrameMilliseconds,
			frameP50: frameTimes.p50 ?? 0,
			frameP95: frameTimes.p95 ?? 0,
			fullSnapshot: updateMilliseconds,
			incrementalUpdate: incrementalNodeUpdateMilliseconds,
			selectionP95: selectionFeedback.p95 ?? 0,
		},
	};
}
