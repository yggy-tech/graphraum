import { afterEach, describe, expect, test } from "vitest";

import {
	CANVAS_HEIGHT,
	CANVAS_WIDTH,
	colorDistance,
	mountGraph,
	renderAndRead,
	unmountGraphs,
} from "./test-support/browser-harness";
import type { GraphraumData } from "./types";

afterEach(() => unmountGraphs());

function oneNode(extra: Record<string, unknown>): GraphraumData {
	return { edges: [], nodes: [{ color: "#ff0000", id: "a", position: { x: 0, y: 0 }, size: 40, ...extra }] };
}

describe("blended node fill in real WebGL2", () => {
	test("a node with blend colours shows them in different parts of the glyph", async () => {
		const graph = mountGraph(
			{ mode: "2d", theme: { background: "#000000" } },
			oneNode({
				blend: [
					{ color: "#00ff00", weight: 0.4 },
					{ color: "#0000ff", weight: 0.4 },
				],
			}),
		);
		graph.setCameraState({ center: { x: 0, y: 0 }, mode: "2d", visibleHeight: 150 });
		const frame = renderAndRead(graph);
		const middleX = CANVAS_WIDTH / 2;
		const middleY = CANVAS_HEIGHT / 2;
		// Pixels per world unit: the canvas shows 150 units over its height.
		const unit = CANVAS_HEIGHT / 150;
		const top = frame.at(middleX, middleY - 0.45 * 40 * unit);
		const left = frame.at(middleX - 0.4 * 40 * unit, middleY + 0.2 * 40 * unit);
		const right = frame.at(middleX + 0.4 * 40 * unit, middleY + 0.2 * 40 * unit);
		expect(top.r).toBeGreaterThan(top.g);
		expect(left.g).toBeGreaterThan(left.r);
		expect(right.b).toBeGreaterThan(right.r);
		expect(colorDistance(left, right)).toBeGreaterThan(60);
	});

	test("a node without blend stays one flat colour", () => {
		const graph = mountGraph({ mode: "2d", theme: { background: "#000000" } }, oneNode({}));
		graph.setCameraState({ center: { x: 0, y: 0 }, mode: "2d", visibleHeight: 150 });
		const frame = renderAndRead(graph);
		const unit = CANVAS_HEIGHT / 150;
		const left = frame.at(CANVAS_WIDTH / 2 - 0.4 * 40 * unit, CANVAS_HEIGHT / 2 + 0.2 * 40 * unit);
		const right = frame.at(CANVAS_WIDTH / 2 + 0.4 * 40 * unit, CANVAS_HEIGHT / 2 + 0.2 * 40 * unit);
		expect(colorDistance(left, right)).toBeLessThan(8);
		expect(left.r).toBeGreaterThan(200);
	});
});
