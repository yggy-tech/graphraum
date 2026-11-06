/**
 * Layout quality harness (#191): deterministic fixtures, both repulsion styles, three entry points.
 * `LAYOUT_QUALITY_REPORT=1 bun run test src/force-layout.quality.test.ts` prints the full table and
 * the per-step timings at 1k and 10k nodes.
 */
import { describe, expect, test } from "vitest";

import {
	computeForcePositions,
	createForceSimulation,
	DEFAULT_FORCE_SETTINGS,
	type ForceRepulsionModel,
	type ForceSettings,
} from "./force-layout";
import {
	chain,
	documentBlockModel,
	type LayoutQuality,
	measureLayout,
	type QualityGraph,
	sparseRandomGraph,
	starForest,
} from "./test-support/layout-quality";

const environment = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const REPORT = environment?.LAYOUT_QUALITY_REPORT === "1";
type Entry = "one-shot" | "live" | "clustered";

function settingsFor(repulsionModel: ForceRepulsionModel): ForceSettings {
	return { ...DEFAULT_FORCE_SETTINGS, repulsionModel };
}

function layout(graph: QualityGraph, model: ForceRepulsionModel, entry: Entry) {
	const request = {
		dimensions: 2 as const,
		edges: graph.edges,
		nodeCount: graph.nodeCount,
		settings: settingsFor(model),
	};
	if (entry === "one-shot") return computeForcePositions(request);
	if (entry === "clustered") return computeForcePositions({ ...request, clusters: graph.groups });
	// The benchmark's live worker steps at a constant alpha of 0.35.
	const simulation = createForceSimulation(request);
	for (let step = 0; step < 300; step += 1) simulation.step(0.35);
	return simulation.positions;
}

const graphs = { chain: chain(), sbm: documentBlockModel(), star: starForest() };
const results = new Map<string, LayoutQuality>();
function quality(name: keyof typeof graphs, model: ForceRepulsionModel, entry: Entry) {
	const key = `${name}/${model}/${entry}`;
	let result = results.get(key);
	if (!result) {
		const graph = graphs[name];
		result = measureLayout(graph, layout(graph, model, entry));
		results.set(key, result);
	}
	return result;
}

describe.each(["one-shot", "live"] as const)("edge-t against classic, %s", (entry) => {
	test("separates the groups of a degree-skewed block model", () => {
		const classic = quality("sbm", "classic", entry);
		const edgeT = quality("sbm", "edge-t", entry);
		expect(edgeT.silhouette).toBeGreaterThan(classic.silhouette + 0.4);
		expect(edgeT.separationRatio).toBeGreaterThan(classic.separationRatio * 1.5);
		expect(edgeT.neighborhoodPreservation).toBeGreaterThan(classic.neighborhoodPreservation + 0.02);
	});

	test("does not regress a long chain", () => {
		const classic = quality("chain", "classic", entry);
		const edgeT = quality("chain", "edge-t", entry);
		expect(edgeT.neighborhoodPreservation).toBeGreaterThanOrEqual(classic.neighborhoodPreservation);
		expect(edgeT.edgeLengthCv).toBeLessThanOrEqual(classic.edgeLengthCv);
	});

	test("does not regress a star forest", () => {
		const classic = quality("star", "classic", entry);
		const edgeT = quality("star", "edge-t", entry);
		expect(edgeT.silhouette).toBeGreaterThan(classic.silhouette + 0.4);
		expect(edgeT.edgeLengthCv).toBeLessThanOrEqual(classic.edgeLengthCv);
	});
});

test("keeps the clustered path at least as separated", () => {
	for (const name of ["sbm", "star"] as const) {
		const classic = quality(name, "classic", "clustered");
		const edgeT = quality(name, "edge-t", "clustered");
		expect(edgeT.silhouette).toBeGreaterThanOrEqual(classic.silhouette - 0.02);
	}
});

test.runIf(REPORT)("reports quality and step timings", () => {
	const rows = [
		"| Graph | Entry | Model | Silhouette | V_g | kNN overlap | Edge CV |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const name of ["sbm", "chain", "star"] as const) {
		for (const entry of ["one-shot", "live", "clustered"] as const) {
			for (const model of ["classic", "edge-t"] as const) {
				const q = quality(name, model, entry);
				rows.push(
					`| ${graphs[name].name} | ${entry} | ${model} | ${q.silhouette.toFixed(3)} | ${q.separationRatio.toFixed(2)} | ${q.neighborhoodPreservation.toFixed(3)} | ${q.edgeLengthCv.toFixed(3)} |`,
				);
			}
		}
	}
	for (const nodeCount of [1_000, 10_000]) {
		const graph = sparseRandomGraph(nodeCount);
		for (const model of ["classic", "edge-t"] as const) {
			const simulation = createForceSimulation({
				dimensions: 2,
				edges: graph.edges,
				nodeCount,
				settings: settingsFor(model),
			});
			for (let step = 0; step < 20; step += 1) simulation.step(0.35);
			const steps = nodeCount === 1_000 ? 400 : 60;
			const started = performance.now();
			for (let step = 0; step < steps; step += 1) simulation.step(0.35);
			rows.push(`step ${nodeCount} ${model}: ${((performance.now() - started) / steps).toFixed(3)} ms`);
		}
	}
	console.log(rows.join("\n"));
});
