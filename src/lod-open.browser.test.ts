import { afterEach, describe, expect, test } from "vitest";
import { type OpenedClusterLod, openClusterLod } from "./lod";
import { mountGraph, unmountGraphs } from "./test-support/browser-harness";

const opened: OpenedClusterLod[] = [];
afterEach(() => {
	for (const lod of opened.splice(0)) lod.detach();
	unmountGraphs();
});

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

function arrays(count: number, dimensions: 2 | 3) {
	const side = Math.ceil(Math.sqrt(count));
	const positions = new Float32Array(count * dimensions);
	for (let node = 0; node < count; node += 1) {
		positions[node * dimensions] = (node % side) * 12;
		positions[node * dimensions + 1] = Math.floor(node / side) * 12;
		if (dimensions === 3) positions[node * 3 + 2] = ((node * 17) % 101) - 50;
	}
	const edges = new Uint32Array(count * 4);
	for (let edge = 0; edge < count * 2; edge += 1) {
		edges[edge * 2] = edge % count;
		edges[edge * 2 + 1] = (edge * 97 + 13) % count;
	}
	return { dimensions, edges, positions };
}

describe.each(["2d", "3d"] as const)("openClusterLod in a real browser, %s", (mode) => {
	test("a module worker builds the tree and the renderer only ever gets the cut", async () => {
		const graph = mountGraph({ mode });
		const input = arrays(60_000, mode === "2d" ? 2 : 3);
		const lod = await openClusterLod(graph, input, {
			createWorker: () => new Worker(new URL("./lod-worker.ts", import.meta.url), { type: "module" }),
			element: document.body.lastElementChild as HTMLElement,
			maxDrawnEdges: 1500,
			maxDrawnNodes: 800,
		});
		opened.push(lod);
		expect(lod.usedWorker).toBe(true);
		// The positions were handed to the worker, not copied.
		expect(input.positions.byteLength).toBe(0);
		await nextFrame();
		const early = graph.getDiagnostics();
		expect(early.totalNodes).toBeGreaterThan(0);
		expect(early.totalNodes).toBeLessThanOrEqual(800);
		expect(early.totalEdges).toBe(0);
		await lod.complete;
		await nextFrame();
		await nextFrame();
		const diagnostics = graph.getDiagnostics();
		expect(diagnostics.totalNodes).toBeLessThanOrEqual(800);
		expect(diagnostics.totalEdges).toBeGreaterThan(0);
		expect(diagnostics.totalEdges).toBeLessThanOrEqual(1500);
		expect(diagnostics.gpuDrawCalls).toBeLessThanOrEqual(3);
		expect(lod.getTimings().buildEdgesMilliseconds).not.toBeNull();
		const id = graph.pick(200, 150);
		if (id) expect(lod.resolve(id)).not.toBeNull();
	});

	test("opens on this thread when no worker is wanted", async () => {
		const graph = mountGraph({ mode });
		const lod = await openClusterLod(graph, arrays(20_000, mode === "2d" ? 2 : 3), {
			element: document.body.lastElementChild as HTMLElement,
			worker: false,
		});
		opened.push(lod);
		expect(lod.usedWorker).toBe(false);
		await lod.complete;
		await nextFrame();
		expect(graph.getDiagnostics().totalEdges).toBeGreaterThan(0);
	});
});
