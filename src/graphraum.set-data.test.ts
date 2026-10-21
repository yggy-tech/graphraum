import type { OrthographicCamera, PerspectiveCamera } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { Graphraum } from "./graphraum";
import { FakeElement, installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumData } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));

const graphs: Graphraum[] = [];
afterEach(() => {
	for (const graph of graphs.splice(0)) graph.destroy();
});

function createGraph(mode: "2d" | "3d") {
	const graph = new Graphraum(new FakeElement(800, 600) as unknown as HTMLElement, { mode });
	graphs.push(graph);
	return graph;
}

function cameraOf(graph: Graphraum) {
	return Reflect.get(graph, "camera") as OrthographicCamera | PerspectiveCamera;
}

function sheet(count: number): GraphraumData {
	return {
		nodes: Array.from({ length: count }, (_, index) => ({
			id: `n${index}`,
			position: { x: (index % 10) * 40, y: Math.floor(index / 10) * 40, z: 0 },
			size: 4,
		})),
		edges: [],
	};
}

/** Pose the camera like a person who zoomed and panned after the first fit. */
function moveCamera(graph: Graphraum) {
	const camera = cameraOf(graph);
	camera.position.set(camera.position.x + 90, camera.position.y - 60, camera.position.z);
	// OrbitControls zooms an orthographic camera by scaling `camera.zoom`; a perspective camera dollies instead.
	if (camera.type === "OrthographicCamera") camera.zoom = 2.5;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();
}

function pose(graph: Graphraum) {
	const camera = cameraOf(graph);
	return { position: camera.position.toArray(), zoom: camera.zoom };
}

describe.each(["2d", "3d"] as const)("setData camera (%s)", (mode) => {
	test("refits the camera by default", () => {
		const graph = createGraph(mode);
		graph.setData(sheet(20));
		const fitted = pose(graph);
		moveCamera(graph);
		expect(pose(graph)).not.toEqual(fitted);

		graph.setData(sheet(30));

		expect(pose(graph)).toEqual(pose(createFitted(mode, sheet(30))));
	});

	test("keeps the camera where it is with fit: false", () => {
		const graph = createGraph(mode);
		graph.setData(sheet(20));
		moveCamera(graph);
		const moved = pose(graph);

		graph.setData(sheet(30), { fit: false });

		expect(pose(graph)).toEqual(moved);
		expect(graph.getDiagnostics().totalNodes).toBe(30);
	});

	test("fit: true behaves like the default", () => {
		const graph = createGraph(mode);
		graph.setData(sheet(20));
		moveCamera(graph);

		graph.setData(sheet(30), { fit: true });

		expect(pose(graph)).toEqual(pose(createFitted(mode, sheet(30))));
	});
});

function createFitted(mode: "2d" | "3d", data: GraphraumData) {
	const graph = createGraph(mode);
	graph.setData(data);
	return graph;
}

describe("setData options", () => {
	test("rejects a non-boolean fit", () => {
		const graph = createGraph("2d");
		expect(() => graph.setData(sheet(3), { fit: "no" as unknown as boolean })).toThrow(/fit must be a boolean/);
	});
});
