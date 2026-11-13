import { type InstancedMesh, Matrix4 } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { edgeGeometryCapacity } from "./edge-rendering";
import { createGraph, destroyGraphs, edgeBuffers, internals, mixedFixture } from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumData } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));
afterEach(destroyGraphs);

function edgeMesh(graph: ReturnType<typeof createGraph>): InstancedMesh {
	const mesh = internals(graph).edgeMesh;
	if (!mesh) throw new Error("edge mesh missing");
	return mesh;
}

/** A ring: every edge is straight, so each takes one instance. */
function straightRing(count: number): GraphraumData {
	return {
		nodes: Array.from({ length: count }, (_, index) => ({
			id: `n${index}`,
			position: { x: Math.cos(index) * 100, y: Math.sin(index) * 100 },
		})),
		edges: Array.from({ length: count }, (_, index) => ({
			id: `e${index}`,
			source: `n${index}`,
			target: `n${(index + 1) % count}`,
		})),
	};
}

describe("edge buffers follow what is drawn", () => {
	test("hold the drawn instances plus headroom, not 26 slots per edge", () => {
		const graph = createGraph({ mode: "2d" });
		graph.setData(straightRing(2_000));
		const mesh = edgeMesh(graph);
		const capacity = edgeGeometryCapacity(mesh.geometry);
		expect(mesh.count).toBe(2_000);
		expect(capacity).toBeGreaterThanOrEqual(mesh.count);
		expect(capacity).toBeLessThanOrEqual(mesh.count + Math.max(mesh.count >> 2, 1_024));
	});

	test("keep no per-slot matrices, yet answer every slot with the identity", () => {
		const graph = createGraph({ mode: "3d" });
		graph.setData(straightRing(500));
		const mesh = edgeMesh(graph);
		expect(mesh.instanceMatrix.array.length).toBe(16);
		const matrix = new Matrix4().makeScale(2, 2, 2);
		mesh.getMatrixAt(499, matrix);
		expect(matrix.equals(new Matrix4())).toBe(true);
	});

	test("grow without losing the instances already written, and shrink after a smaller pass", () => {
		const graph = createGraph({ mode: "3d" });
		graph.setData(mixedFixture(60, 120, 7));
		const before = edgeBuffers(graph);
		const heldBefore = edgeGeometryCapacity(edgeMesh(graph).geometry);
		const reserve = Reflect.get(graph, "reserveEdgeInstances") as (slots: number, keep?: number) => void;
		reserve.call(graph, heldBefore * 2);
		const grown = edgeGeometryCapacity(edgeMesh(graph).geometry);
		expect(grown).toBeGreaterThanOrEqual(heldBefore * 2);
		expect(edgeBuffers(graph)).toEqual(before);

		graph.setData(straightRing(10));
		expect(edgeGeometryCapacity(edgeMesh(graph).geometry)).toBeLessThan(grown);
	});
});
