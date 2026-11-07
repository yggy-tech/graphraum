import { afterEach, describe, expect, test } from "vitest";
import type { Graphraum } from "./graphraum";
import { graphraumStylePresets } from "./styles";
import {
	colorDistance,
	hexToRgb,
	mountGraph,
	type Rgb,
	renderAndRead,
	unmountGraphs,
} from "./test-support/browser-harness";
import type { GraphraumData, GraphraumOptions } from "./types";

afterEach(unmountGraphs);

const data: GraphraumData = {
	nodes: [
		{ id: "left", position: { x: -60, y: 0, z: 0 }, size: 4 },
		{ id: "hub", position: { x: 0, y: 0, z: 0 }, size: 14 },
		{ id: "right", position: { x: 60, y: 0, z: 0 }, size: 4 },
	],
	edges: [{ id: "top", source: "left", target: "right", marker: "triangle" }],
};

/** Colours at the background, the hub centre, and the middle of the edge between left and the hub. */
function probes(graph: Graphraum) {
	const frame = renderAndRead(graph);
	const hub = graph.getNodeScreenPosition("hub");
	const left = graph.getNodeScreenPosition("left");
	if (!hub?.visible || !left?.visible) throw new Error("expected the hub and left node on screen");
	return {
		background: frame.at(4, 4),
		edge: frame.at((hub.x + left.x) / 2, (hub.y + left.y) / 2),
		hub: frame.at(hub.x, hub.y),
		ring: Array.from({ length: 100 }, (_, step) => frame.at(hub.x + step, hub.y)),
	};
}

function mount(options: GraphraumOptions) {
	return mountGraph({ mode: "2d", ...options }, data);
}

const distance = (a: Rgb, b: Rgb) => colorDistance(a, b);

describe("style presets in real WebGL2", () => {
	test("classicDark renders the same pixels as the default look", () => {
		const base = probes(mount({}));
		const classic = probes(mount({ style: graphraumStylePresets.classicDark }));
		expect(distance(classic.background, base.background)).toBe(0);
		expect(distance(classic.hub, base.hub)).toBe(0);
		expect(distance(classic.edge, base.edge)).toBe(0);
		expect(classic.ring).toEqual(base.ring);
		// The default is still the original dark look.
		expect(distance(base.background, hexToRgb("#040f0f"))).toBeLessThanOrEqual(3);
		expect(distance(base.hub, hexToRgb("#226f54"))).toBeLessThanOrEqual(6);
	});

	test("neutral and blueprint look different from the default", () => {
		const base = probes(mount({}));
		const neutral = probes(mount({ style: graphraumStylePresets.neutral }));
		const blueprint = probes(mount({ style: graphraumStylePresets.blueprint }));
		expect(distance(neutral.hub, base.hub)).toBeGreaterThan(20);
		expect(distance(blueprint.background, hexToRgb("#0b2545"))).toBeLessThanOrEqual(3);
		expect(distance(blueprint.background, base.background)).toBeGreaterThan(20);
		expect(distance(blueprint.hub, hexToRgb("#8da9c4"))).toBeLessThanOrEqual(6);
	});

	test("setStyle repaints in place and a node stroke default draws a ring", () => {
		const graph = mount({});
		expect(probes(graph).ring.every((pixel) => distance(pixel, hexToRgb("#fcfffc")) > 40)).toBe(true);
		graph.setStyle({ node: { strokeWidth: 3 } });
		expect(probes(graph).ring.some((pixel) => distance(pixel, hexToRgb("#fcfffc")) <= 6)).toBe(true);
		graph.setStyle(graphraumStylePresets.blueprint);
		expect(distance(probes(graph).background, hexToRgb("#0b2545"))).toBeLessThanOrEqual(3);
		graph.setStyle(graphraumStylePresets.classicDark);
		expect(distance(probes(graph).background, hexToRgb("#040f0f"))).toBeLessThanOrEqual(3);
	});

	test.each(["2d", "3d"] as const)("keeps the draw calls and per-frame counts in %s whatever the style", (mode) => {
		const counts = Object.values(graphraumStylePresets).map((style) => {
			const graph = mountGraph({ mode, style }, data);
			renderAndRead(graph);
			const { gpuDrawCalls, gpuGeometries, visibleEdgeMarkers, visibleEdgeSegments, visibleNodes } =
				graph.getDiagnostics();
			return { gpuDrawCalls, gpuGeometries, visibleEdgeMarkers, visibleEdgeSegments, visibleNodes };
		});
		expect(counts[0]?.gpuDrawCalls).toBe(2);
		for (const count of counts) expect(count).toEqual(counts[0]);
	});
});
