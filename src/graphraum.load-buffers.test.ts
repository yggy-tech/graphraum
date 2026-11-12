import type { BufferAttribute, InstancedMesh } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { Graphraum } from "./graphraum";
import { FakeElement, installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumData, GraphraumEdgeStyle, GraphraumNodeShape } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));

const graphs: Graphraum[] = [];
afterEach(() => {
	for (const graph of graphs.splice(0)) graph.destroy();
});

const SHAPES: readonly (GraphraumNodeShape | undefined)[] = [undefined, "square", "diamond", "hexagon", "pill"];
const STYLES: readonly (GraphraumEdgeStyle | undefined)[] = [undefined, "dashed", "solid"];
const COLORS = [undefined, "#ff8800", "#3366cc"];

/** A fixed graph that exercises node shapes, sizes, strokes, colors and edge styles, markers and paths. */
function fixture(): GraphraumData {
	const count = 300;
	const nodes = Array.from({ length: count }, (_, index) => ({
		color: COLORS[index % COLORS.length],
		id: `n${index}`,
		position: { x: ((index * 37) % 101) * 3, y: ((index * 53) % 97) * 3, z: (index % 7) * 5 },
		shape: SHAPES[index % SHAPES.length],
		size: index % 4 === 0 ? 6 : undefined,
		strokeWidth: index % 5 === 0 ? 1 : undefined,
		width: index % 11 === 0 ? 9 : undefined,
	}));
	const edges = Array.from({ length: count * 2 }, (_, index) => ({
		color: COLORS[index % COLORS.length],
		id: `e${index}`,
		marker: index % 3 === 0 ? ("triangle" as const) : undefined,
		path: index % 5 === 0 ? ("quadratic" as const) : undefined,
		source: `n${index % count}`,
		style: STYLES[index % STYLES.length],
		target: `n${(index * 7 + 1) % count}`,
		width: index % 4 === 0 ? 2 : undefined,
	}));
	return { edges, nodes };
}

function hash(arrays: Iterable<ArrayLike<number>>) {
	let h = 0x811c9dc5;
	for (const array of arrays) {
		const bytes = new Uint8Array(
			(array as unknown as Float32Array).buffer,
			(array as Float32Array).byteOffset,
			(array as Float32Array).byteLength,
		);
		for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

function meshArrays(mesh: InstancedMesh) {
	const attributes = Object.values(mesh.geometry.attributes) as BufferAttribute[];
	return [
		mesh.instanceMatrix.array,
		...(mesh.instanceColor ? [mesh.instanceColor.array] : []),
		...attributes.map((attribute) => attribute.array),
		new Float32Array([mesh.count]),
	];
}

function bufferHashes(mode: "2d" | "3d") {
	const graph = new Graphraum(new FakeElement(800, 600) as unknown as HTMLElement, { mode });
	graphs.push(graph);
	graph.setData(fixture());
	const nodeMesh = Reflect.get(graph, "nodeMesh") as InstancedMesh;
	const pickMesh = Reflect.get(graph, "nodePickMesh") as InstancedMesh;
	const edgeMesh = Reflect.get(graph, "edgeMesh") as InstancedMesh;
	return {
		edges: hash(meshArrays(edgeMesh)),
		nodePick: hash([pickMesh.instanceMatrix.array]),
		nodes: hash(meshArrays(nodeMesh)),
	};
}

describe("buffers after setData", () => {
	test.each([
		["2d", { edges: "c91019bc", nodePick: "7846f06e", nodes: "b950a4be" }],
		["3d", { edges: "a05dec98", nodePick: "14a1ad5e", nodes: "c287ce5e" }],
	] as const)("are byte-identical to the recorded layout (%s)", (mode, expected) => {
		expect(bufferHashes(mode)).toEqual(expected);
	});
});
