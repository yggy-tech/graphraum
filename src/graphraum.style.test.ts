import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { Graphraum } from "./graphraum";
import { graphraumStylePresets } from "./styles";
import { FakeElement, installFakeBrowserGlobals } from "./test-support/fake-webgl";
import { graphraumThemeDark } from "./theme";
import type { GraphraumData, GraphraumOptions } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));

const graphs: Graphraum[] = [];
afterEach(() => {
	for (const graph of graphs.splice(0)) graph.destroy();
});

function createGraph(options: GraphraumOptions = {}) {
	const properties = new Map<string, string>();
	const container = new FakeElement(800, 600);
	Object.defineProperty(container, "style", {
		value: {
			removeProperty: (name: string) => properties.delete(name),
			setProperty: (name: string, value: string) => properties.set(name, value),
		},
	});
	const graph = new Graphraum(container as unknown as HTMLElement, options);
	graphs.push(graph);
	return { graph, properties };
}

const data: GraphraumData = {
	edges: [{ id: "ab", source: "a", target: "b" }],
	nodes: [
		{ id: "a", position: { x: -10, y: 0 }, size: 4 },
		{ id: "b", position: { x: 10, y: 0 }, size: 4 },
	],
};

describe("style", () => {
	test("the constructor writes label variables and a graph without a style writes none", () => {
		expect(createGraph().properties.size).toBe(0);
		const { properties } = createGraph({ style: { label: { font: "serif" } } });
		expect(Object.fromEntries(properties)).toEqual({ "--graphraum-label-font": "serif" });
	});

	test("setStyle changes the look in place without rebuilding geometry", () => {
		const { graph, properties } = createGraph();
		graph.setData(data);
		const before = graph.getDiagnostics();
		graph.setStyle(graphraumStylePresets.blueprint);
		const after = graph.getDiagnostics();
		expect(after.gpuGeometries).toBe(before.gpuGeometries);
		expect(after.visibleNodes).toBe(before.visibleNodes);
		expect(properties.get("--graphraum-label-font")).toContain("monospace");
		graph.setStyle(graphraumStylePresets.classicDark);
		expect(properties.size).toBe(0);
		expect(Reflect.get(graph, "theme")).toEqual(graphraumThemeDark);
	});

	test("setStyle with a bad value throws and leaves the style unchanged", () => {
		const { graph, properties } = createGraph({ style: { label: { font: "serif" } } });
		expect(() => graph.setStyle({ label: { fg: "red" }, node: { strokeWidth: -1 } })).toThrow(/node\.strokeWidth/);
		expect(Object.fromEntries(properties)).toEqual({ "--graphraum-label-font": "serif" });
	});

	test("style.theme wins over the theme shorthand and setTheme still works", () => {
		const { graph } = createGraph({ theme: "light", style: { theme: { node: "#123456" } } });
		expect(Reflect.get(graph, "theme")).toMatchObject({ background: "#fcfffc", node: "#123456" });
		graph.setTheme("dark");
		expect(Reflect.get(graph, "theme")).toEqual(graphraumThemeDark);
	});
});
