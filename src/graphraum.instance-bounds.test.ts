import type { InstancedMesh } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { createGraph, destroyGraphs } from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));
afterEach(() => {
	destroyGraphs();
	vi.restoreAllMocks();
});

const meshes = (graph: object) => ({
	nodes: Reflect.get(graph, "nodeMesh") as InstancedMesh,
	pick: Reflect.get(graph, "nodePickMesh") as InstancedMesh,
});

describe("node instance bounds", () => {
	test("nodes are never culled as one mesh by bounds measured before they moved", () => {
		const graph = createGraph({ mode: "3d" });
		graph.setData({ nodes: [{ id: "a", position: { x: 0, y: 0, z: 0 }, size: 1 }], edges: [] });
		expect(meshes(graph).nodes.frustumCulled).toBe(false);
	});

	test("the pick mesh measures its bounds again after a node moves", () => {
		const graph = createGraph({ mode: "3d" });
		graph.setData({
			nodes: [
				{ id: "a", position: { x: 0, y: 0, z: 0 }, size: 1 },
				{ id: "b", position: { x: 1, y: 0, z: 0 }, size: 1 },
			],
			edges: [],
		});
		const { pick } = meshes(graph);
		pick.computeBoundingSphere();
		graph.updateNodes([{ id: "b", position: { x: 5000, y: 0, z: 0 } }]);
		// A raycast measures bounds only when none are kept.
		expect(pick.boundingSphere).toBeNull();
	});
});
