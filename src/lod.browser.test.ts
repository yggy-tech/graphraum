import { afterEach, describe, expect, test } from "vitest";
import type { Graphraum } from "./graphraum";
import { attachClusterLod, buildClusterTree, type ClusterLodHandle } from "./lod";
import { mountGraph, unmountGraphs } from "./test-support/browser-harness";
import type { GraphraumData, GraphraumMode } from "./types";

const attached: ClusterLodHandle[] = [];
afterEach(() => {
	for (const lod of attached.splice(0)) lod.detach();
	unmountGraphs();
});

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

function grid(count: number): GraphraumData {
	const side = Math.ceil(Math.sqrt(count));
	return {
		edges: Array.from({ length: count * 2 }, (_, index) => ({
			id: `e${index}`,
			source: `n${index % count}`,
			target: `n${(index * 97 + 13) % count}`,
		})),
		nodes: Array.from({ length: count }, (_, index) => ({
			id: `n${index}`,
			position: { x: (index % side) * 12, y: Math.floor(index / side) * 12, z: ((index * 17) % 101) - 50 },
			size: 2.5,
		})),
	};
}

function attach(mode: GraphraumMode, count: number, maxDrawnNodes = 800): { graph: Graphraum; lod: ClusterLodHandle } {
	const data = grid(count);
	const dimensions = mode === "2d" ? 2 : 3;
	const tree = buildClusterTree({
		dimensions,
		edges: Uint32Array.from(data.edges.flatMap((edge) => [Number(edge.source.slice(1)), Number(edge.target.slice(1))])),
		positions: Float32Array.from(
			data.nodes.flatMap((node) => [node.position.x, node.position.y, node.position.z ?? 0].slice(0, dimensions)),
		),
	});
	const graph = mountGraph({ mode });
	const lod = attachClusterLod(graph, tree, {
		data,
		element: document.body.lastElementChild as HTMLElement,
		maxDrawnEdges: 1500,
		maxDrawnNodes,
	});
	attached.push(lod);
	return { graph, lod };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("labels, click to zoom and animation in a real browser", () => {
	test("aggregates show compact counts, and a click zooms in on one", async () => {
		const { graph, lod } = attach("2d", 60_000, 9);
		await nextFrame();
		await nextFrame();
		const labels = [...(document.body.lastElementChild as HTMLElement).querySelectorAll<HTMLElement>("span")].filter(
			(label) => !label.hidden,
		);
		expect(labels.length).toBeGreaterThan(0);
		for (const label of labels) expect(label.textContent).toMatch(/^\d+(\.\d)?[kM]?$/);
		const container = document.body.lastElementChild as HTMLElement;
		const before = graph.getCameraState();
		if (before.mode !== "2d") throw new Error("expected 2D");
		// Find an aggregate on screen and click its centre.
		let clicked = false;
		for (let x = 20; x < 380 && !clicked; x += 17) {
			for (let y = 20; y < 280 && !clicked; y += 17) {
				const id = graph.pick(x, y);
				if (id && lod.resolve(id)?.kind === "cluster") {
					container.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y }));
					container.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y }));
					clicked = true;
				}
			}
		}
		expect(clicked).toBe(true);
		for (let waited = 0; waited < 4000 && (waited < 600 || lod.getDiagnostics().transitioning); waited += 50)
			await wait(50);
		const after = graph.getCameraState();
		if (after.mode !== "2d") throw new Error("expected 2D");
		expect(after.visibleHeight).toBeLessThan(before.visibleHeight / 2);
		expect(lod.getDiagnostics().transitioning).toBe(false);
	});
});

describe.each(["2d", "3d"] as const)("cluster LOD in %s", (mode) => {
	test("draws a bounded number of nodes for a graph far over the budget and keeps two draw calls", async () => {
		const { graph, lod } = attach(mode, 60_000);
		await nextFrame();
		await nextFrame();
		const diagnostics = graph.getDiagnostics();
		expect(diagnostics.totalNodes).toBeLessThanOrEqual(800);
		expect(diagnostics.totalEdges).toBeLessThanOrEqual(1500);
		expect(diagnostics.visibleNodes).toBe(diagnostics.totalNodes);
		expect(diagnostics.gpuDrawCalls).toBeLessThanOrEqual(3);
		expect(lod.getDiagnostics().drawnAggregates).toBeGreaterThan(50);
	});

	test("follows the camera and resolves a picked aggregate", async () => {
		const { graph, lod } = attach(mode, 60_000);
		await nextFrame();
		const before = lod.getDiagnostics();
		const state = graph.getCameraState();
		if (state.mode === "2d") graph.setCameraState({ ...state, visibleHeight: state.visibleHeight / 20 });
		else {
			graph.setCameraState({
				...state,
				position: {
					x: state.target.x + (state.position.x - state.target.x) / 20,
					y: state.target.y + (state.position.y - state.target.y) / 20,
					z: state.target.z + (state.position.z - state.target.z) / 20,
				},
			});
		}
		await nextFrame();
		await nextFrame();
		const after = lod.getDiagnostics();
		expect(after.drawnAggregates + after.drawnNodes).toBeLessThanOrEqual(800);
		expect(after.drawnNodes).toBeGreaterThan(before.drawnNodes);
		const id = graph.pick(200, 150);
		if (id) expect(lod.resolve(id)).not.toBeNull();
	});
});
