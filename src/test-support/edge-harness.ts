/**
 * Shared Graphraum test harness for edge-state tests. Test files must mock `three`'s
 * WebGLRenderer with `FakeWebGLRenderer` before importing this module.
 */
import type { BufferAttribute, InstancedMesh, OrthographicCamera, PerspectiveCamera } from "three";
import { EDGE_INSTANCE_ATTRIBUTES } from "../edge-rendering";
import type { VisibleEdgeLayout } from "../edge-viewport-patch";
import { Graphraum } from "../graphraum";
import type { GraphraumData, GraphraumEdge, GraphraumOptions } from "../types";
import { FakeElement } from "./fake-webgl";

export interface GraphraumInternals {
	camera: OrthographicCamera | PerspectiveCamera;
	data: GraphraumData;
	edgeMesh: InstancedMesh | null;
	handleViewChange(): void;
	materializeViewport(): void;
	visibleEdgeLayouts: Map<number, VisibleEdgeLayout>;
}

export const EDGE_ATTRIBUTES = EDGE_INSTANCE_ATTRIBUTES;

export function internals(graph: Graphraum): GraphraumInternals {
	return graph as unknown as GraphraumInternals;
}

const graphs: Graphraum[] = [];

/** Creates a renderer on a fake container; call `destroyGraphs` in `afterEach`. */
export function createGraph(options: GraphraumOptions = {}) {
	const graph = new Graphraum(new FakeElement() as unknown as HTMLElement, options);
	graphs.push(graph);
	return graph;
}

export function destroyGraphs() {
	for (const graph of graphs.splice(0)) graph.destroy();
}

export function seededRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

/** Mixed fixture: curves, markers, domain colors and opacities so every pack branch is exercised. */
export function mixedFixture(nodeCount: number, edgeCount: number, seed: number): GraphraumData {
	const random = seededRandom(seed);
	const nodes = Array.from({ length: nodeCount }, (_, index) => ({
		id: `n${index}`,
		position: { x: random() * 400 - 200, y: random() * 400 - 200, z: random() * 40 - 20 },
	}));
	const paths = ["straight", "quadratic", "cubic"] as const;
	const edges = Array.from({ length: edgeCount }, (_, index): GraphraumEdge => {
		const source = Math.floor(random() * nodeCount);
		const target = (source + 1 + Math.floor(random() * (nodeCount - 1))) % nodeCount;
		return {
			id: `e${index}`,
			source: `n${source}`,
			target: `n${target}`,
			...(index % 3 === 0 ? { color: "#6d5bd0" } : {}),
			...(index % 4 === 0 ? { opacity: 0.3 } : {}),
			...(index % 5 === 0 ? { marker: "triangle" as const, markerEnd: "both" as const } : {}),
			path: paths[index % paths.length],
		};
	});
	return { nodes, edges };
}

export function edgeBuffers(graph: Graphraum) {
	const mesh = internals(graph).edgeMesh;
	if (!mesh) throw new Error("edge mesh missing");
	return Object.fromEntries(
		EDGE_ATTRIBUTES.map((name) => {
			const attribute = mesh.geometry.getAttribute(name);
			return [name, Array.from(attribute.array.slice(0, mesh.count * attribute.itemSize))];
		}),
	);
}

/** Instance data grouped by edge index so slot order does not matter. */
export function edgeInstancesByEdge(graph: Graphraum) {
	const mesh = internals(graph).edgeMesh;
	if (!mesh) throw new Error("edge mesh missing");
	const byEdge = [...internals(graph).visibleEdgeLayouts.entries()].sort(([left], [right]) => left - right);
	return byEdge.map(([edgeIndex, layout]) => {
		const slots = [
			...Array.from({ length: layout.segmentCount }, (_, offset) => layout.segmentStart + offset),
			...Array.from({ length: layout.markerCount }, (_, offset) => layout.markerStart + offset),
		];
		return {
			edgeIndex,
			instances: slots.map((slot) =>
				EDGE_ATTRIBUTES.flatMap((name) => {
					const attribute = mesh.geometry.getAttribute(name);
					return Array.from(attribute.array.slice(slot * attribute.itemSize, (slot + 1) * attribute.itemSize));
				}),
			),
		};
	});
}

export function edgeColorSlots(graph: Graphraum, edgeIndex: number): number[][] {
	const mesh = internals(graph).edgeMesh;
	const layout = internals(graph).visibleEdgeLayouts.get(edgeIndex);
	if (!mesh || !layout) throw new Error(`edge ${edgeIndex} is not visible`);
	const color = mesh.geometry.getAttribute("instanceColor");
	const slots = [
		...Array.from({ length: layout.segmentCount }, (_, offset) => layout.segmentStart + offset),
		...Array.from({ length: layout.markerCount }, (_, offset) => layout.markerStart + offset),
	];
	return slots.map((slot) => [color.getX(slot), color.getY(slot), color.getZ(slot), color.getW(slot)]);
}

export function pickSubset(random: () => number, ids: readonly string[], probability: number) {
	return ids.filter(() => random() < probability);
}

/**
 * Mirrors three.js r185 `WebGLAttributes` uploads for the edge attributes: a new attribute
 * uploads whole; a newer version uploads its update ranges (or everything when none), then
 * clears them. Comparing the shadow with the CPU arrays catches dropped or missing ranges.
 */
export function createShadowGpu(options: { includeNodes?: boolean } = {}) {
	const uploaded = new Map<object, { data: Float32Array; version: number }>();
	const attributes = (graph: Graphraum) => {
		const mesh = internals(graph).edgeMesh;
		if (!mesh) throw new Error("edge mesh missing");
		const edges = EDGE_ATTRIBUTES.map((name) => ({
			attribute: mesh.geometry.getAttribute(name) as BufferAttribute,
			count: mesh.count,
		}));
		if (!options.includeNodes) return edges;
		// The node instance attributes ride along: matrix, color and the three geometry attributes.
		const nodes = Reflect.get(graph, "nodeMesh") as InstancedMesh;
		const nodeAttributes = [
			nodes.instanceMatrix,
			nodes.instanceColor,
			...["instanceShape", "instanceStrokeWidth", "instanceStrokeColor"].map((name) =>
				nodes.geometry.getAttribute(name),
			),
		];
		return [
			...edges,
			...nodeAttributes.flatMap((attribute) =>
				attribute ? [{ attribute: attribute as BufferAttribute, count: nodes.count }] : [],
			),
		];
	};
	return {
		/** Simulates one rendered frame. */
		upload(graph: Graphraum) {
			for (const { attribute } of attributes(graph)) {
				if (!(attribute.array instanceof Float32Array)) throw new Error("expected a Float32Array attribute");
				const entry = uploaded.get(attribute);
				if (!entry) {
					uploaded.set(attribute, { data: attribute.array.slice(), version: attribute.version });
					continue;
				}
				if (entry.version === attribute.version) continue;
				if (attribute.updateRanges.length === 0) entry.data.set(attribute.array);
				for (const { count, start } of attribute.updateRanges) {
					entry.data.set(attribute.array.subarray(start, start + count), start);
				}
				attribute.clearUpdateRanges();
				entry.version = attribute.version;
			}
		},
		/** Drawn instances as the GPU would see them, next to the CPU arrays. */
		compare(graph: Graphraum) {
			return attributes(graph).map(({ attribute, count }) => ({
				cpu: Array.from(attribute.array.slice(0, count * attribute.itemSize)),
				gpu: Array.from(uploaded.get(attribute)?.data.slice(0, count * attribute.itemSize) ?? []),
			}));
		},
	};
}
