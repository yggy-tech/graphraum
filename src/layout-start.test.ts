import { expect, test } from "vitest";

import { DEFAULT_FORCE_SETTINGS } from "./force-layout";
import { pivotMdsPositions } from "./layout-start";
import { chain, documentBlockModel, foldCount, gridStrip, normalizedStress } from "./test-support/layout-quality";

const at = (positions: Float32Array, node: number) => [positions[node * 3] ?? 0, positions[node * 3 + 1] ?? 0] as const;
const request = (graph: { edges: Uint32Array; nodeCount: number }, extra = {}) => ({
	dimensions: 2 as const,
	edges: graph.edges,
	nodeCount: graph.nodeCount,
	...extra,
});

test("defaults to the engine's link distance", () => {
	const graph = chain(30);
	const first = pivotMdsPositions(request(graph));
	expect(pivotMdsPositions(request(graph, { linkDistance: DEFAULT_FORCE_SETTINGS.linkDistance }))).toEqual(first);
	const wide = pivotMdsPositions(request(graph, { linkDistance: 48 }));
	expect(Math.hypot(...at(wide, 29)) / Math.hypot(...at(first, 29))).toBeCloseTo(2, 5);
});

test("lays a path out as a straight line, one link distance per hop", () => {
	const positions = pivotMdsPositions(request(chain(30)));
	const [firstX, firstY] = at(positions, 0);
	const [lastX, lastY] = at(positions, 29);
	const length = Math.hypot(lastX - firstX, lastY - firstY);
	expect(length).toBeGreaterThan(29 * 24 * 0.95);
	expect(length).toBeLessThan(29 * 24 * 1.05);
	let previous = Number.NEGATIVE_INFINITY;
	for (let node = 0; node < 30; node += 1) {
		const [x, y] = at(positions, node);
		const along = ((x - firstX) * (lastX - firstX) + (y - firstY) * (lastY - firstY)) / length;
		expect(along).toBeGreaterThan(previous);
		expect(Math.abs((x - firstX) * (lastY - firstY) - (y - firstY) * (lastX - firstX)) / length).toBeLessThan(0.05);
		previous = along;
	}
});

test("lays a grid strip out lengthwise without folds", () => {
	const strip = gridStrip(4, 30);
	const positions = pivotMdsPositions(request(strip));
	const [leftX, leftY] = at(positions, 0);
	const [rightX, rightY] = at(positions, 29);
	const [sideX, sideY] = at(positions, 90);
	// Classical MDS of the grid's hop metric (not Euclidean) overstates the width; it stays clearly lengthwise.
	expect(Math.hypot(rightX - leftX, rightY - leftY)).toBeGreaterThan(2 * Math.hypot(sideX - leftX, sideY - leftY));
	expect(strip.strip && foldCount(strip.strip, positions)).toBe(0);
	expect(normalizedStress(strip, positions)).toBeLessThan(0.3);
});

test("is deterministic and finite in 2D and 3D", () => {
	const graph = documentBlockModel();
	const first = pivotMdsPositions(request(graph));
	expect(pivotMdsPositions(request(graph))).toEqual(first);
	expect(first.every(Number.isFinite)).toBe(true);
	expect(first.every((value, index) => index % 3 !== 2 || value === 0)).toBe(true);
	const spatial = pivotMdsPositions(request(graph, { dimensions: 3 }));
	expect(spatial.every(Number.isFinite)).toBe(true);
	expect(spatial.some((value, index) => index % 3 === 2 && value !== 0)).toBe(true);
});

test("packs components apart and marks isolated nodes with NaN", () => {
	// Two paths of 5 nodes (0 to 4, 5 to 9) and the isolated node 10.
	const edges = new Uint32Array([0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 6, 7, 7, 8, 8, 9]);
	const positions = pivotMdsPositions({ dimensions: 2, edges, nodeCount: 11 });
	expect(Number.isNaN(positions[30])).toBe(true);
	const box = (nodes: number[]) => {
		const xs = nodes.map((node) => at(positions, node)[0]);
		const ys = nodes.map((node) => at(positions, node)[1]);
		return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] as const;
	};
	const [ax0, ax1, ay0, ay1] = box([0, 1, 2, 3, 4]);
	const [bx0, bx1, by0, by1] = box([5, 6, 7, 8, 9]);
	expect(ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0).toBe(true);
	expect(Number.isFinite(ax0 + ay0 + bx0 + by0)).toBe(true);
});

test("handles a graph without edges", () => {
	const positions = pivotMdsPositions({ dimensions: 2, edges: new Uint32Array(), nodeCount: 3 });
	expect(positions.every(Number.isNaN) || positions.filter((_, index) => index % 3 === 0).every(Number.isNaN)).toBe(
		true,
	);
	expect(pivotMdsPositions({ dimensions: 2, edges: new Uint32Array(), nodeCount: 0 })).toHaveLength(0);
});

test("validates its input", () => {
	const base = request(chain(5));
	expect(() => pivotMdsPositions({ ...base, dimensions: 4 as never })).toThrow(/dimensions/);
	expect(() => pivotMdsPositions({ ...base, nodeCount: -1 })).toThrow(/node count/);
	expect(() => pivotMdsPositions({ ...base, edges: new Uint32Array(3) })).toThrow(/pairs/);
	expect(() => pivotMdsPositions({ ...base, linkDistance: 0 })).toThrow(/link distance/);
	expect(() => pivotMdsPositions({ ...base, linkDistance: Number.NaN })).toThrow(/link distance/);
	expect(() => pivotMdsPositions(base, { pivots: 1 })).toThrow(/pivots/);
	expect(() => pivotMdsPositions(base, { pivots: 2.5 })).toThrow(/pivots/);
	expect(() => pivotMdsPositions(base, { pivots: 1000 })).toThrow(/pivots/);
});
