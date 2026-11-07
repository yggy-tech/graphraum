import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createIconAtlas, phosphorIcon } from "./icons";
import { graphraumScenes } from "./scene";
import {
	colorDistance,
	mountGraph,
	renderAndRead,
	shaderPrograms,
	unmountGraphs,
} from "./test-support/browser-harness";
import type { GraphraumData, GraphraumMode } from "./types";

const BACKGROUND = "#102030";
const DARK_FILL = "#203040";
const LIGHT_FILL = "#e8e0c8";
const theme = { background: BACKGROUND, edge: "#3cc8e0", edgeOpacity: 1, edgeWidth: 2, node: DARK_FILL } as const;

// A disc that fills most of its cell, and a ring with a hole in the middle.
const DISC = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"/></svg>';
const RING =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M50 0a50 50 0 1 0 0.01 0zM50 30a20 20 0 1 1-0.01 0z"/></svg>';

let consoleProblems: unknown[][] = [];

beforeEach(() => {
	consoleProblems = [];
	const record = (...args: unknown[]) => consoleProblems.push(args);
	vi.spyOn(console, "error").mockImplementation(record);
	vi.spyOn(console, "warn").mockImplementation(record);
});

afterEach(() => {
	unmountGraphs();
	vi.restoreAllMocks();
});

const data: GraphraumData = {
	edges: [{ id: "e", source: "with", target: "without" }],
	nodes: [
		{ id: "with", icon: 0, position: { x: -25, y: 0, z: 0 }, shape: "circle", size: 12 },
		{ id: "without", position: { x: 25, y: 0, z: 0 }, shape: "circle", size: 12 },
	],
};

function brightness(color: { r: number; g: number; b: number }) {
	return (color.r + color.g + color.b) / 3;
}

async function mountWithIcons(
	options: Parameters<typeof mountGraph>[0] = {},
	iconOptions: Parameters<ReturnType<typeof mountGraph>["setIconAtlas"]>[1] = {},
	graphData: GraphraumData = data,
) {
	const atlas = await createIconAtlas([DISC, RING]);
	const graph = mountGraph({ theme, ...options });
	graph.setData(graphData);
	graph.setIconAtlas(atlas, iconOptions);
	graph.fitView();
	return { atlas, graph };
}

function positions(graph: ReturnType<typeof mountGraph>) {
	const withIcon = graph.getNodeScreenPosition("with");
	const without = graph.getNodeScreenPosition("without");
	if (!withIcon?.visible || !without?.visible) throw new Error("expected both nodes on screen");
	return { without, withIcon };
}

describe("icons in real WebGL2", () => {
	test("builds an atlas with mipmaps from SVG strings", async () => {
		const atlas = await createIconAtlas([DISC, RING, DISC]);
		expect(atlas).toMatchObject({ columns: 2, count: 3, padding: 0.125, rows: 2 });
		expect(atlas.texture.generateMipmaps).toBe(true);
		expect(atlas.texture.flipY).toBe(false);
		atlas.dispose();
	});

	test.each([
		["2d", undefined],
		["3d", undefined],
		["3d", "lit"],
		["3d", "toon"],
	] as const)("tints the icon in %s %s and leaves the other node alone, in two draw calls", async (mode, shading) => {
		const { atlas, graph } = await mountWithIcons(
			{ mode: mode as GraphraumMode, ...(shading ? { scene: graphraumScenes[shading] } : {}) },
			{ color: "#ffffff" },
		);
		const frame = renderAndRead(graph);
		const { without, withIcon } = positions(graph);
		expect(brightness(frame.at(withIcon.x, withIcon.y))).toBeGreaterThan(200);
		expect(brightness(frame.at(without.x, without.y))).toBeLessThan(140);
		expect(graph.getDiagnostics().gpuDrawCalls).toBe(2);
		for (const program of shaderPrograms(graph)) expect(program.diagnostics?.runnable ?? true, program.name).toBe(true);
		expect(consoleProblems).toEqual([]);
		atlas.dispose();
	});

	test("picks light or dark from the fill when no colour is set", async () => {
		const light: GraphraumData = {
			...data,
			nodes: data.nodes.map((node) => ({ ...node, color: LIGHT_FILL })),
		};
		const dark = await mountWithIcons();
		const darkFrame = renderAndRead(dark.graph);
		const darkAt = positions(dark.graph).withIcon;
		expect(brightness(darkFrame.at(darkAt.x, darkAt.y))).toBeGreaterThan(200);
		unmountGraphs();

		const bright = await mountWithIcons({}, {}, light);
		const brightFrame = renderAndRead(bright.graph);
		const brightAt = positions(bright.graph).withIcon;
		expect(brightness(brightFrame.at(brightAt.x, brightAt.y))).toBeLessThan(60);
	});

	test("draws the ring's hole as fill and scales the icon with the node", async () => {
		const ring: GraphraumData = { ...data, nodes: data.nodes.map((node) => ({ ...node, icon: 1 })) };
		const { graph } = await mountWithIcons({}, { color: "#ffffff", scale: 0.9 }, ring);
		const frame = renderAndRead(graph);
		const { withIcon } = positions(graph);
		expect(brightness(frame.at(withIcon.x, withIcon.y))).toBeLessThan(100);
		// Radius is 12 world units; find the screen size of one unit from the two nodes.
		const { without } = positions(graph);
		const unit = (without.x - withIcon.x) / 50;
		expect(brightness(frame.at(withIcon.x + 10.5 * unit, withIcon.y))).toBeGreaterThan(170);
	});

	test("leaves nodes without an icon pixel-identical to a graph with no atlas", async () => {
		const plain = mountGraph({ theme }, data);
		plain.fitView();
		const before = renderAndRead(plain);
		const { without } = positions(plain);
		const { graph } = await mountWithIcons();
		const after = renderAndRead(graph);
		let different = 0;
		for (let dy = -14; dy <= 14; dy += 1) {
			for (let dx = -14; dx <= 14; dx += 1) {
				if (colorDistance(before.at(without.x + dx, without.y + dy), after.at(without.x + dx, without.y + dy)) > 0) {
					different += 1;
				}
			}
		}
		expect(different).toBe(0);
	});

	test("adds, changes and removes icons live", async () => {
		const { graph } = await mountWithIcons({}, { color: "#ffffff" });
		const { without } = positions(graph);
		expect(brightness(renderAndRead(graph).at(without.x, without.y))).toBeLessThan(140);
		graph.updateNodes([{ icon: 0, id: "without" }]);
		expect(brightness(renderAndRead(graph).at(without.x, without.y))).toBeGreaterThan(200);
		graph.updateNodes([{ icon: undefined, id: "without" }]);
		expect(brightness(renderAndRead(graph).at(without.x, without.y))).toBeLessThan(140);
		graph.setIconAtlas(null);
		const { withIcon } = positions(graph);
		expect(brightness(renderAndRead(graph).at(withIcon.x, withIcon.y))).toBeLessThan(140);
		expect(graph.getDiagnostics().gpuDrawCalls).toBe(2);
	});

	test("rejects bad indices with actionable errors", async () => {
		const atlas = await createIconAtlas([DISC, RING]);
		const graph = mountGraph({ theme });
		expect(() => graph.setData({ nodes: [{ id: "a", icon: -1, position: { x: 0, y: 0 } }], edges: [] })).toThrow(
			/Node "a" icon must be a non-negative integer/,
		);
		expect(() => graph.setData({ nodes: [{ id: "a", icon: 1.5, position: { x: 0, y: 0 } }], edges: [] })).toThrow(
			/non-negative integer/,
		);
		graph.setData(data);
		graph.setIconAtlas(atlas);
		expect(() => graph.updateNodes([{ icon: 2, id: "with" }])).toThrow(
			/Node "with" icon 2 is outside the icon atlas, which has 2 icons/,
		);
		expect(() => graph.setData({ nodes: [{ id: "b", icon: 5, position: { x: 0, y: 0 } }], edges: [] })).toThrow(
			/Node "b" icon 5 is outside/,
		);
		const tooSmall = await createIconAtlas([DISC]);
		graph.setData(data);
		graph.setIconAtlas(atlas);
		graph.updateNodes([{ icon: 1, id: "with" }]);
		expect(() => graph.setIconAtlas(tooSmall)).toThrow(/Node "with" icon 1 is outside/);
		expect(() => graph.setIconAtlas(atlas, { scale: 2 })).toThrow(/scale/);
	});
});

describe("phosphorIcon", () => {
	test("declares the namespace and size and drops currentColor", () => {
		const raw = '<svg viewBox="0 0 256 256" fill="currentColor"><path d="M0 0h256v256H0z"/></svg>';
		const prepared = phosphorIcon(raw);
		expect(prepared).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(prepared).toContain('width="256"');
		expect(prepared).not.toContain("currentColor");
		expect(() => phosphorIcon("nope")).toThrow(/SVG string/);
	});

	test("rasterises into an atlas cell", async () => {
		const atlas = await createIconAtlas([
			phosphorIcon('<svg viewBox="0 0 256 256"><rect width="256" height="256"/></svg>'),
		]);
		expect(atlas.count).toBe(1);
		atlas.dispose();
	});
});
