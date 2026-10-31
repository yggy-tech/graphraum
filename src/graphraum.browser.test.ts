import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { graphraumScenes } from "./scene";
import {
	colorDistance,
	hexToRgb,
	mountGraph,
	renderAndRead,
	shaderPrograms,
	unmountGraphs,
} from "./test-support/browser-harness";
import type { GraphraumData, GraphraumMode, GraphraumNodeShape } from "./types";

const BACKGROUND = "#102030";
const NODE = "#e0503c";
const EDGE = "#3cc8e0";
const SHAPES: GraphraumNodeShape[] = ["circle", "diamond", "hexagon", "pill", "rounded", "square", "triangle"];

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

/** Every shape, stroke, edge style, marker and path kind, so each shader branch compiles and draws. */
function catalog(): GraphraumData {
	const nodes = SHAPES.map((shape, index) => ({
		id: shape,
		position: { x: (index - 3) * 30, y: index % 2 === 0 ? 20 : -20, z: (index % 3) * 10 },
		shape,
		size: 8,
		strokeWidth: index % 2,
		glow: index === 0 ? 1 : 0,
	}));
	const edges = SHAPES.slice(1).map((shape, index) => ({
		id: `e-${shape}`,
		source: SHAPES[index] ?? "circle",
		target: shape,
		style: (["solid", "dashed", "dotted"] as const)[index % 3],
		marker: index % 2 === 0 ? ("triangle" as const) : ("none" as const),
		path: (["straight", "quadratic", "cubic"] as const)[index % 3],
	}));
	return { edges, nodes };
}

function expectCleanCompile(graph: Parameters<typeof shaderPrograms>[0]) {
	const programs = shaderPrograms(graph);
	expect(programs.length).toBeGreaterThan(0);
	for (const program of programs) expect(program.diagnostics?.runnable ?? true, program.name).toBe(true);
	expect(consoleProblems).toEqual([]);
}

describe("shaders compile and draw in real WebGL2", () => {
	test.each(["2d", "3d"] as const)("draws the full shape, stroke and edge catalog in %s", (mode: GraphraumMode) => {
		const graph = mountGraph({ mode }, catalog());
		renderAndRead(graph);
		expectCleanCompile(graph);
		const diagnostics = graph.getDiagnostics();
		expect(diagnostics.visibleNodes).toBe(SHAPES.length);
		expect(diagnostics.visibleEdges).toBe(SHAPES.length - 1);
	});

	test.each(["lit", "toon"] as const)("draws the catalog with %s shading and shared depth in 3D", (shading) => {
		const graph = mountGraph({ mode: "3d", scene: graphraumScenes[shading] }, catalog());
		renderAndRead(graph);
		expectCleanCompile(graph);
		expect(graph.getDiagnostics()).toMatchObject({ shading, edgeDepth: "scene" });
	});

	test("draws 3D depth of field passes for a selection", () => {
		const graph = mountGraph(
			{ mode: "3d", depthOfField: { enabled: true, strength: 1, transition: { durationMs: 0 } } },
			catalog(),
		);
		graph.setSelection(["circle"]);
		renderAndRead(graph);
		expectCleanCompile(graph);
		expect(graph.getDiagnostics().depthOfField).toBe("active");
	});
});

describe("draw call budget", () => {
	const plain: GraphraumData = {
		nodes: [
			{ id: "a", position: { x: -20, y: 0, z: 0 } },
			{ id: "b", position: { x: 20, y: 0, z: 0 } },
		],
		edges: [{ id: "ab", source: "a", target: "b" }],
	};

	test.each(["2d", "3d"] as const)("keeps one node and one edge draw in %s", (mode: GraphraumMode) => {
		const graph = mountGraph({ mode }, plain);
		renderAndRead(graph);
		expect(graph.getDiagnostics().gpuDrawCalls).toBe(2);
	});

	test.each(["lit", "toon"] as const)("keeps one node and one edge draw with %s shading", (shading) => {
		const graph = mountGraph({ mode: "3d", scene: graphraumScenes[shading] }, plain);
		renderAndRead(graph);
		expect(graph.getDiagnostics().gpuDrawCalls).toBe(2);
	});

	test("adds exactly one batched draw for glowing nodes", () => {
		const glowing = { ...plain, nodes: plain.nodes.map((node) => ({ ...node, glow: 1 })) };
		const graph = mountGraph({ mode: "3d" }, glowing);
		renderAndRead(graph);
		expect(graph.getDiagnostics().gpuDrawCalls).toBe(3);
	});
});

describe("pixels", () => {
	const theme = { background: BACKGROUND, edge: EDGE, edgeOpacity: 1, edgeWidth: 3, node: NODE } as const;
	const crossing: GraphraumData = {
		nodes: [
			{ id: "left", position: { x: -60, y: 0, z: 0 }, size: 4 },
			{ id: "hub", position: { x: 0, y: 0, z: 0 }, size: 14 },
			{ id: "right", position: { x: 60, y: 0, z: 0 }, size: 4 },
		],
		// Runs straight through the hub, which must cover it.
		edges: [{ id: "through", source: "left", target: "right" }],
	};

	test.each(["2d", "3d"] as const)("paints the background, nodes over edges and visible edges in %s", (mode) => {
		const graph = mountGraph({ mode, theme }, crossing);
		const frame = renderAndRead(graph);
		const hub = graph.getNodeScreenPosition("hub");
		const left = graph.getNodeScreenPosition("left");
		if (!hub?.visible || !left?.visible) throw new Error("expected the hub and left node on screen");

		expect(colorDistance(frame.at(4, 4), hexToRgb(BACKGROUND))).toBeLessThanOrEqual(3);
		expect(colorDistance(frame.at(hub.x, hub.y), hexToRgb(NODE))).toBeLessThanOrEqual(6);
		const between = frame.at((hub.x + left.x) / 2, (hub.y + left.y) / 2);
		expect(colorDistance(between, hexToRgb(EDGE))).toBeLessThanOrEqual(12);
		expect(consoleProblems).toEqual([]);
	});

	test.each(["lit", "toon"] as const)("lights the side of a %s sphere that faces the sun", (shading) => {
		const lone: GraphraumData = {
			nodes: [
				{ id: "hub", position: { x: 0, y: 0, z: 0 }, size: 14 },
				{ id: "ruler", position: { x: 60, y: 0, z: 0 }, size: 1 },
			],
			edges: [],
		};
		// Low sun from the right: azimuth 90 points along +x.
		const scene = { shading, sun: { azimuth: 90, elevation: 10, intensity: 1 }, ambient: { intensity: 0.3 } };
		const graph = mountGraph({ mode: "3d", theme, scene }, lone);
		const frame = renderAndRead(graph);
		const hub = graph.getNodeScreenPosition("hub");
		const ruler = graph.getNodeScreenPosition("ruler");
		if (!hub?.visible || !ruler?.visible) throw new Error("expected the hub and the ruler on screen");
		const offset = ((ruler.x - hub.x) / 60) * 14 * 0.35;
		const brightness = ({ r, g, b }: { r: number; g: number; b: number }) => r + g + b;
		const lit = brightness(frame.at(hub.x + offset, hub.y));
		const away = brightness(frame.at(hub.x - offset, hub.y));
		expect(lit).toBeGreaterThan(away + 60);
		expect(colorDistance(frame.at(4, 4), hexToRgb(BACKGROUND))).toBeLessThanOrEqual(3);
		expect(consoleProblems).toEqual([]);
	});

	test("flat shading in 3D keeps the node colour across the node", () => {
		const graph = mountGraph({ mode: "3d", theme, scene: graphraumScenes.flat }, crossing);
		const frame = renderAndRead(graph);
		const hub = graph.getNodeScreenPosition("hub");
		if (!hub?.visible) throw new Error("expected the hub on screen");
		expect(colorDistance(frame.at(hub.x, hub.y), hexToRgb(NODE))).toBeLessThanOrEqual(6);
	});
});
