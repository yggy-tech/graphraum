import { afterEach, describe, expect, test, vi } from "vitest";

import {
	CANVAS_HEIGHT,
	CANVAS_WIDTH,
	colorDistance,
	mountGraph,
	renderAndRead,
	unmountGraphs,
} from "./test-support/browser-harness";
import { seededRandom } from "./test-support/edge-harness";
import type { GraphraumData } from "./types";

afterEach(() => unmountGraphs());

function field(): GraphraumData {
	const random = seededRandom(11);
	const nodes = Array.from({ length: 300 }, (_, index) => ({
		id: `n${index}`,
		position: { x: random() * 600 - 300, y: random() * 600 - 300 },
	}));
	const edges = Array.from({ length: 700 }, (_, index) => ({
		id: `e${index}`,
		source: `n${index % 300}`,
		target: `n${Math.floor(random() * 300)}`,
		...(index % 4 === 0 ? { marker: "triangle" as const } : {}),
	}));
	return { edges, nodes };
}

describe("2D edges that stay in view keep their instances, in real WebGL2", () => {
	test("a pan and zoom sequence paints what a full rewrite paints", () => {
		const data = field();
		const graph = mountGraph({ mode: "2d" }, data);
		const twin = mountGraph({ mode: "2d" }, data);
		const rewrite = (twin as unknown as { materializeViewport(): void }).materializeViewport.bind(twin);
		const patched = vi.spyOn(graph as unknown as { patchEdgeSlots(): boolean }, "patchEdgeSlots");
		const random = seededRandom(5);
		let height = 500;
		let x = 0;
		let y = 0;
		let differing = 0;
		let samples = 0;
		for (let step = 0; step < 24; step += 1) {
			if (random() < 0.6) {
				x += (random() - 0.5) * 160;
				y += (random() - 0.5) * 160;
			} else height = Math.min(900, Math.max(150, height * (0.7 + random() * 0.7)));
			graph.setCameraState({ center: { x, y }, mode: "2d", visibleHeight: height });
			twin.setCameraState({ center: { x, y }, mode: "2d", visibleHeight: height });
			rewrite();
			const painted = renderAndRead(graph);
			const expected = renderAndRead(twin);
			for (let py = 0; py < CANVAS_HEIGHT; py += 3) {
				for (let px = 0; px < CANVAS_WIDTH; px += 3) {
					samples += 1;
					if (colorDistance(painted.at(px, py), expected.at(px, py)) > 16) differing += 1;
				}
			}
			expect(graph.getDiagnostics().visibleEdges).toBe(twin.getDiagnostics().visibleEdges);
		}
		expect(patched.mock.results.filter(({ value }) => value === true).length).toBeGreaterThan(8);
		// Overlapping edges may paint in another order, which moves a few antialiased pixels only.
		expect(differing / samples).toBeLessThan(0.005);
	});
});
