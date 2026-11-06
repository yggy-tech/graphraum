/**
 * Layout quality harness (#191): deterministic fixtures, both layout styles, three entry points.
 * The style presets were tuned on the "tuning" fixtures; the "held-out" fixtures (another seed and
 * shape of the block model, dense communities, a binary tree) were added afterwards and not tuned on.
 * `LAYOUT_QUALITY_REPORT=1 bun run test src/force-layout.quality.test.ts` prints the full table and
 * per-step and one-shot timings (1k, 10k sparse, 10k dense, 100k).
 */
import { describe, expect, test } from "vitest";

import {
	computeForcePositions,
	createForceSimulation,
	DEFAULT_FORCE_SETTINGS,
	type ForceLayoutRequest,
	type ForceLayoutStyle,
} from "./force-layout";
import { pivotMdsPositions } from "./layout-start";
import {
	binaryTree,
	chain,
	denseCommunities,
	documentBlockModel,
	foldCount,
	gridStrip,
	type LayoutQuality,
	measureLayout,
	type QualityGraph,
	sparseRandomGraph,
	starForest,
} from "./test-support/layout-quality";

const environment = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const REPORT = environment?.LAYOUT_QUALITY_REPORT === "1";
type Entry = "one-shot" | "live" | "clustered" | "one-shot 3D";
const STYLES = ["classic", "edge-t"] as const;

function request(graph: QualityGraph, layoutStyle: ForceLayoutStyle, dimensions: 2 | 3): ForceLayoutRequest {
	return {
		dimensions,
		edges: graph.edges,
		nodeCount: graph.nodeCount,
		settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle },
	};
}

function layout(graph: QualityGraph, style: ForceLayoutStyle, entry: Entry) {
	if (entry === "one-shot") return computeForcePositions(request(graph, style, 2));
	if (entry === "one-shot 3D") return computeForcePositions(request(graph, style, 3));
	if (entry === "clustered") return computeForcePositions({ ...request(graph, style, 2), clusters: graph.groups });
	// The benchmark's live worker steps at a constant alpha of 0.35.
	const simulation = createForceSimulation(request(graph, style, 2));
	for (let step = 0; step < 300; step += 1) simulation.step(0.35);
	return simulation.positions;
}

const graphs = {
	chain: chain(),
	dense: denseCommunities(),
	sbm: documentBlockModel(),
	sbmHeldOut: documentBlockModel(7, [140, 70, 50, 40, 30, 20, 20, 15, 10, 5]),
	star: starForest(),
	tree: binaryTree(),
};
type GraphName = keyof typeof graphs;
const results = new Map<string, LayoutQuality>();
function quality(name: GraphName, style: ForceLayoutStyle, entry: Entry) {
	const key = `${name}/${style}/${entry}`;
	let result = results.get(key);
	if (!result) {
		const graph = graphs[name];
		result = measureLayout(graph, layout(graph, style, entry));
		results.set(key, result);
	}
	return result;
}

describe.each(["one-shot", "live"] as const)("tuning fixtures, %s", (entry) => {
	test("separates the groups of a degree-skewed block model", () => {
		const classic = quality("sbm", "classic", entry);
		const edgeT = quality("sbm", "edge-t", entry);
		expect(edgeT.silhouette).toBeGreaterThan(0.25);
		expect(edgeT.silhouette).toBeGreaterThan(classic.silhouette + 0.4);
		expect(edgeT.separationRatio).toBeGreaterThan(Math.max(3, classic.separationRatio * 1.5));
		expect(edgeT.neighborhoodPreservation).toBeGreaterThan(classic.neighborhoodPreservation + 0.03);
		// Cross-group edges get longer; keep that trade-off bounded.
		expect(edgeT.edgeLengthCv).toBeLessThan(0.7);
	});

	test("keeps a long chain unfolded and even", () => {
		const classic = quality("chain", "classic", entry);
		const edgeT = quality("chain", "edge-t", entry);
		expect(edgeT.neighborhoodPreservation).toBeGreaterThan(0.2);
		expect(edgeT.neighborhoodPreservation).toBeGreaterThan(classic.neighborhoodPreservation);
		expect(edgeT.edgeLengthCv).toBeLessThan(Math.min(0.3, classic.edgeLengthCv));
	});

	test("separates the stars of a star forest", () => {
		const classic = quality("star", "classic", entry);
		const edgeT = quality("star", "edge-t", entry);
		expect(edgeT.silhouette).toBeGreaterThan(0.8);
		expect(edgeT.silhouette).toBeGreaterThan(classic.silhouette + 0.4);
		expect(edgeT.edgeLengthCv).toBeLessThan(Math.min(0.2, classic.edgeLengthCv));
	});
});

describe.each(["one-shot", "live"] as const)("held-out fixtures, %s", (entry) => {
	test("separates another block model seed and shape", () => {
		const classic = quality("sbmHeldOut", "classic", entry);
		const edgeT = quality("sbmHeldOut", "edge-t", entry);
		expect(edgeT.silhouette).toBeGreaterThan(0.1);
		expect(edgeT.silhouette).toBeGreaterThan(classic.silhouette + 0.25);
		expect(edgeT.separationRatio).toBeGreaterThan(classic.separationRatio * 1.5);
		expect(edgeT.neighborhoodPreservation).toBeGreaterThan(classic.neighborhoodPreservation + 0.03);
		expect(edgeT.edgeLengthCv).toBeLessThan(0.9);
	});

	test("separates dense communities", () => {
		const classic = quality("dense", "classic", entry);
		const edgeT = quality("dense", "edge-t", entry);
		expect(edgeT.silhouette).toBeGreaterThan(0.6);
		expect(edgeT.silhouette).toBeGreaterThan(classic.silhouette + 0.2);
		expect(edgeT.neighborhoodPreservation).toBeGreaterThanOrEqual(classic.neighborhoodPreservation);
		expect(edgeT.edgeLengthCv).toBeLessThan(1.6);
	});

	test("keeps a binary tree's neighbourhoods", () => {
		const classic = quality("tree", "classic", entry);
		const edgeT = quality("tree", "edge-t", entry);
		expect(edgeT.neighborhoodPreservation).toBeGreaterThan(Math.max(0.08, classic.neighborhoodPreservation + 0.05));
		expect(edgeT.edgeLengthCv).toBeLessThan(0.5);
	});
});

test("separates the block model in 3D", () => {
	const classic = quality("sbm", "classic", "one-shot 3D");
	const edgeT = quality("sbm", "edge-t", "one-shot 3D");
	expect(edgeT.silhouette).toBeGreaterThan(0.3);
	expect(edgeT.silhouette).toBeGreaterThan(classic.silhouette + 0.4);
});

test("keeps the clustered path at least as separated", () => {
	for (const name of ["sbm", "star"] as const) {
		const classic = quality(name, "classic", "clustered");
		const edgeT = quality(name, "edge-t", "clustered");
		expect(edgeT.silhouette).toBeGreaterThan(0.8);
		expect(edgeT.silhouette).toBeGreaterThanOrEqual(classic.silhouette - 0.02);
	}
});

function timeStyle(graph: QualityGraph, style: ForceLayoutStyle, steps: number) {
	const simulation = createForceSimulation(request(graph, style, 2));
	for (let step = 0; step < 10; step += 1) simulation.step(0.35);
	let started = performance.now();
	for (let step = 0; step < steps; step += 1) simulation.step(0.35);
	const perStep = (performance.now() - started) / steps;
	started = performance.now();
	computeForcePositions(request(graph, style, 2));
	return `${perStep.toFixed(3)} ms per step, one-shot ${(performance.now() - started).toFixed(0)} ms`;
}

test.runIf(REPORT)("reports quality and timings", () => {
	const rows = [
		"| Graph | Entry | Style | Silhouette | V_g | kNN overlap | Edge CV |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	const entries: Record<GraphName, Entry[]> = {
		chain: ["one-shot", "live"],
		dense: ["one-shot", "live"],
		sbm: ["one-shot", "live", "clustered", "one-shot 3D"],
		sbmHeldOut: ["one-shot", "live"],
		star: ["one-shot", "live", "clustered"],
		tree: ["one-shot", "live"],
	};
	for (const name of Object.keys(entries) as GraphName[]) {
		for (const entry of entries[name]) {
			for (const style of STYLES) {
				const q = quality(name, style, entry);
				rows.push(
					`| ${graphs[name].name}${name === "sbmHeldOut" ? " (held-out seed)" : ""} | ${entry} | ${style} | ${q.silhouette.toFixed(3)} | ${q.separationRatio.toFixed(2)} | ${q.neighborhoodPreservation.toFixed(3)} | ${q.edgeLengthCv.toFixed(3)} |`,
				);
			}
		}
	}
	const timings: [string, QualityGraph, number][] = [
		["1k, mean degree 3", sparseRandomGraph(1_000), 400],
		["10k, mean degree 3", sparseRandomGraph(10_000), 60],
		["10k, mean degree 30", sparseRandomGraph(10_000, 7, 30), 30],
		["100k, mean degree 3", sparseRandomGraph(100_000), 10],
	];
	for (const [label, graph, steps] of timings) {
		for (const style of STYLES) rows.push(`${label} ${style}: ${timeStyle(graph, style, steps)}`);
	}
	console.log(rows.join("\n"));
});

test("a pivot MDS start unfolds an aspect 200 strip that a random start leaves folded (#193)", () => {
	const strip = gridStrip(2, 400);
	const probe = strip.strip as NonNullable<QualityGraph["strip"]>;
	const plain = request(strip, "classic", 2);
	const random = computeForcePositions(plain);
	const pivot = computeForcePositions({ ...plain, initialPositions: pivotMdsPositions(plain) });
	expect(foldCount(probe, random)).toBeGreaterThan(50);
	expect(foldCount(probe, pivot)).toBeLessThanOrEqual(4);
});
