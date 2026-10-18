import { InstancedMesh, ShaderMaterial } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { EDGE_RENDER_ORDER } from "./edge-rendering";
import type { Graphraum } from "./graphraum";
import { GLOW_RENDER_ORDER } from "./node-glow-rendering";
import { NODE_RENDER_ORDER } from "./node-rendering";
import { createGraph, destroyGraphs, edgeBuffers, internals } from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumMode } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));
afterEach(() => destroyGraphs());

function shaderMesh(mesh: unknown): { material: ShaderMaterial; renderOrder: number } {
	if (!(mesh instanceof InstancedMesh) || !(mesh.material instanceof ShaderMaterial)) {
		throw new Error("expected an instanced shader mesh");
	}
	return { material: mesh.material, renderOrder: mesh.renderOrder };
}

function meshes(graph: Graphraum) {
	const graphInternals = graph as unknown as { edgeMesh: unknown; nodeMesh: unknown };
	return { edges: shaderMesh(internals(graph).edgeMesh), nodes: shaderMesh(graphInternals.nodeMesh) };
}

function hub(mode: GraphraumMode) {
	const graph = createGraph({ mode });
	graph.setData({
		edges: [{ id: "e", source: "a", target: "b" }],
		nodes: [
			{ id: "a", position: { x: 0, y: 0, z: 0 } },
			{ id: "b", position: { x: 20, y: 0, z: 40 } },
		],
	});
	return graph;
}

function expectEdgesUnderNodes(graph: Graphraum, mode: GraphraumMode) {
	const { edges, nodes } = meshes(graph);
	// Transparent objects sort by renderOrder before depth, so edges always draw first.
	expect(edges.renderOrder).toBeLessThan(nodes.renderOrder);
	expect(edges.material).toMatchObject({ depthTest: false, depthWrite: false, transparent: true });
	expect(nodes.material).toMatchObject({ depthTest: mode === "3d", depthWrite: mode === "3d", transparent: true });
}

describe("edge and node draw order", () => {
	test("layers glow halos under edges and edges under nodes", () => {
		expect(GLOW_RENDER_ORDER).toBeLessThan(EDGE_RENDER_ORDER);
		expect(EDGE_RENDER_ORDER).toBeLessThan(NODE_RENDER_ORDER);
	});

	test.each(["2d", "3d"] as const)("draws edges under nodes without touching depth in %s", (mode) => {
		expectEdgesUnderNodes(hub(mode), mode);
	});

	test.each([
		["2d", "3d"],
		["3d", "2d"],
	] as const)("keeps edges under nodes after switching from %s to %s", (from, to) => {
		const graph = hub(from);
		graph.setMode(to);
		expectEdgesUnderNodes(graph, to);
	});
});

describe("edge ends at node outlines", () => {
	// Hub fixture: default size 4, default clearance 0.75, chord (20, 0, 40) of length √2000.
	test("leaves 3D ends at the centers for the shader to trim on screen, and trims 2D along xy", () => {
		const graph = hub("3d");
		const length = Math.hypot(20, 40);
		expect(edgeBuffers(graph).instanceEndA).toEqual([0, 0, 0]);
		const [trimStart, trimEnd] = edgeBuffers(graph).instanceTrim ?? [];
		expect(trimStart).toBeCloseTo(4 - 0.75, 5);
		expect(trimEnd).toBeCloseTo(4 - 0.75, 5);

		graph.setMode("2d");
		const flatT = 4 / 20 - 0.75 / length;
		const [flatX, , flatZ] = edgeBuffers(graph).instanceEndA ?? [];
		expect(flatX).toBeCloseTo(20 * flatT, 4);
		expect(flatZ).toBeCloseTo(40 * flatT, 4);
	});
});
