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
import { graphraumScenes, SCENE_DEFAULTS, sunDirection } from "./scene";
import { createGraph, destroyGraphs, edgeBuffers, internals } from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumMode, GraphraumOptions } from "./types";

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

function hub(mode: GraphraumMode, options: GraphraumOptions = {}) {
	const graph = createGraph({ ...options, mode });
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

function expectSharedDepth(graph: Graphraum) {
	const { edges, nodes } = meshes(graph);
	// Nodes write sphere depth first; edges then test against it without writing.
	expect(edges.renderOrder).toBeGreaterThan(nodes.renderOrder);
	expect(edges.material).toMatchObject({ depthTest: true, depthWrite: false, transparent: true });
	expect(nodes.material).toMatchObject({ depthTest: true, depthWrite: true });
	expect(nodes.material.defines).toHaveProperty("GRAPHRAUM_SPHERE_IMPOSTOR");
}

describe("edges that share depth with nodes", () => {
	test("tests edges against sphere impostors in 3D", () => {
		const graph = hub("3d", { scene: { edgeDepth: "scene" } });
		expectSharedDepth(graph);
		expect(graph.getScene()).toMatchObject({ edgeDepth: "scene", shading: "flat" });
		expect(graph.getDiagnostics().edgeDepth).toBe("scene");
	});

	test("falls back to today's layering in 2D and restores scene depth in 3D", () => {
		const graph = hub("3d", { scene: { edgeDepth: "scene" } });
		graph.setMode("2d");
		expectEdgesUnderNodes(graph, "2d");
		expect(meshes(graph).nodes.material.defines).not.toHaveProperty("GRAPHRAUM_SPHERE_IMPOSTOR");
		expect(graph.getDiagnostics().edgeDepth).toBe("behind-nodes");
		graph.setMode("3d");
		expectSharedDepth(graph);
	});

	test("switches at runtime with setScene and keeps the option across setData", () => {
		const graph = hub("3d");
		expectEdgesUnderNodes(graph, "3d");
		graph.setScene({ edgeDepth: "scene" });
		expectSharedDepth(graph);
		graph.setData({ edges: [], nodes: [{ id: "a", position: { x: 0, y: 0, z: 0 } }] });
		expectSharedDepth(graph);
		graph.setScene({ edgeDepth: "behind-nodes" });
		expectEdgesUnderNodes(graph, "3d");
	});

	test("rejects invalid scene options before changing anything", () => {
		const graph = hub("3d");
		expect(() => graph.setScene({ edgeDepth: "x" } as unknown as GraphraumOptions["scene"] & object)).toThrow(
			/scene\.edgeDepth/,
		);
		expect(graph.getScene()).toEqual(SCENE_DEFAULTS);
		expect(() => graph.setScene({ shading: "lit", sun: { elevation: 120 } })).toThrow(
			"scene.sun.elevation must be 10..85, got 120.",
		);
		expect(graph.getScene()).toEqual(SCENE_DEFAULTS);
	});
});

describe("lit and toon shading", () => {
	const lightUniform = (graph: Graphraum, name: string) => meshes(graph).nodes.material.uniforms[name]?.value;

	test("lights the nodes in 3D with the shading define and the sun's uniforms", () => {
		const graph = hub("3d", { scene: graphraumScenes.lit });
		const { defines } = meshes(graph).nodes.material;
		expect(defines).toMatchObject({ GRAPHRAUM_SHADING: "1", GRAPHRAUM_SPHERE_IMPOSTOR: "" });
		expect(graph.getDiagnostics()).toMatchObject({ shading: "lit", edgeDepth: "scene" });
		const [x, y, z] = sunDirection(SCENE_DEFAULTS.sun.azimuth, SCENE_DEFAULTS.sun.elevation);
		expect(lightUniform(graph, "graphraumSunDirection")).toMatchObject({ x, y, z });
		expect(lightUniform(graph, "graphraumSunColor").r).toBeCloseTo(SCENE_DEFAULTS.sun.intensity);
	});

	test("switches style and light at runtime and keeps them across setData", () => {
		const graph = hub("3d");
		expect(meshes(graph).nodes.material.defines ?? {}).not.toHaveProperty("GRAPHRAUM_SHADING");
		graph.setScene({ shading: "toon", sun: { azimuth: 90, elevation: 10 } });
		expect(meshes(graph).nodes.material.defines).toMatchObject({ GRAPHRAUM_SHADING: "2" });
		expect(lightUniform(graph, "graphraumSunDirection").x).toBeCloseTo(Math.cos(Math.PI / 18));
		graph.setData({ edges: [], nodes: [{ id: "a", position: { x: 0, y: 0, z: 0 } }] });
		expect(meshes(graph).nodes.material.defines).toMatchObject({ GRAPHRAUM_SHADING: "2" });
		expect(lightUniform(graph, "graphraumSunDirection").x).toBeCloseTo(Math.cos(Math.PI / 18));
		graph.setScene({ shading: "flat" });
		expect(meshes(graph).nodes.material.defines).not.toHaveProperty("GRAPHRAUM_SHADING");
		expect(graph.getDiagnostics().shading).toBe("flat");
	});

	test("renders flat in 2D and lights again back in 3D", () => {
		const graph = hub("3d", { scene: { shading: "lit" } });
		graph.setMode("2d");
		expect(meshes(graph).nodes.material.defines).not.toHaveProperty("GRAPHRAUM_SHADING");
		expect(graph.getDiagnostics().shading).toBe("flat");
		expectEdgesUnderNodes(graph, "2d");
		graph.setMode("3d");
		expect(meshes(graph).nodes.material.defines).toMatchObject({ GRAPHRAUM_SHADING: "1" });
	});

	test("recompiles only when a define changes, not for a new sun", () => {
		const graph = hub("3d", { scene: { shading: "lit" } });
		const material = meshes(graph).nodes.material;
		const version = material.version;
		graph.setScene({ sun: { azimuth: 30 }, ambient: { intensity: 1 } });
		expect(material.version).toBe(version);
		graph.setScene({ shading: "toon" });
		expect(material.version).toBeGreaterThan(version);
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
