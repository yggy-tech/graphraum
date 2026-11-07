import { describe, expect, test } from "vitest";

import { prepareNodeUpdates } from "./node-updates";

const nodes = [
	{ id: "a", position: { x: 1, y: 2 }, color: "red", size: 4 },
	{ id: "b", position: { x: 3, y: 4 } },
] as const;
const indices = new Map([
	["a", 0],
	["b", 1],
]);

describe("prepareNodeUpdates", () => {
	test("merges partial updates without mutating the source", () => {
		const prepared = prepareNodeUpdates(nodes, indices, [
			{ id: "a", position: { x: 8, y: 9 }, color: undefined, shape: "diamond" },
		]);
		expect(prepared).toEqual([
			{
				colorChanged: true,
				glowChanged: false,
				iconChanged: false,
				index: 0,
				next: { id: "a", position: { x: 8, y: 9 }, color: undefined, shape: "diamond", size: 4 },
				positionChanged: true,
				shapeChanged: true,
				sizeChanged: false,
				strokeChanged: false,
			},
		]);
		expect(nodes[0]).toEqual({ id: "a", position: { x: 1, y: 2 }, color: "red", size: 4 });
	});

	test("merges width, height, strokeWidth, and strokeColor and marks the matching flags", () => {
		const prepared = prepareNodeUpdates(nodes, indices, [
			{ id: "b", width: 6, height: 3, strokeWidth: 1, strokeColor: "#fcfffc" },
		]);
		expect(prepared).toEqual([
			{
				colorChanged: false,
				glowChanged: false,
				iconChanged: false,
				index: 1,
				next: {
					id: "b",
					position: { x: 3, y: 4 },
					width: 6,
					height: 3,
					strokeWidth: 1,
					strokeColor: "#fcfffc",
				},
				positionChanged: false,
				shapeChanged: false,
				sizeChanged: true,
				strokeChanged: true,
			},
		]);
	});

	test("marks sizeChanged when only width or only height changes", () => {
		expect(prepareNodeUpdates(nodes, indices, [{ id: "a", width: 6 }])[0]).toMatchObject({
			sizeChanged: true,
			strokeChanged: false,
		});
		expect(prepareNodeUpdates(nodes, indices, [{ id: "a", height: 6 }])[0]).toMatchObject({
			sizeChanged: true,
			strokeChanged: false,
		});
	});

	test("marks strokeChanged when only strokeColor changes", () => {
		expect(prepareNodeUpdates(nodes, indices, [{ id: "a", strokeColor: "#000000" }])[0]).toMatchObject({
			sizeChanged: false,
			strokeChanged: true,
		});
	});

	test("merges glow and marks glowChanged, including removal", () => {
		const [set] = prepareNodeUpdates(nodes, indices, [{ id: "a", glow: 0.8 }]);
		expect(set).toMatchObject({ colorChanged: false, glowChanged: true, next: { glow: 0.8 } });
		const [cleared] = prepareNodeUpdates([{ ...nodes[0], glow: 0.8 }], indices, [{ id: "a", glow: undefined }]);
		expect(cleared).toMatchObject({ glowChanged: true });
		expect(cleared?.next.glow).toBeUndefined();
		expect(prepareNodeUpdates(nodes, indices, [{ id: "a", size: 6 }])[0]?.glowChanged).toBe(false);
	});

	test("rejects glow outside 0..1 before renderer mutation", () => {
		expect(() => prepareNodeUpdates(nodes, indices, [{ id: "a", glow: 2 }])).toThrow(
			'Node "a" glow must be a finite number between 0 and 1',
		);
	});

	test("rejects an invalid batch before renderer mutation", () => {
		expect(() => prepareNodeUpdates(nodes, indices, [{ id: "a", size: 0 }])).toThrow(
			'Node "a" width must be a positive finite number',
		);
		expect(() => prepareNodeUpdates(nodes, indices, [{ id: "a", width: -1 }])).toThrow(
			'Node "a" width must be a positive finite number',
		);
		expect(() => prepareNodeUpdates(nodes, indices, [{ id: "a", height: 0 }])).toThrow(
			'Node "a" height must be a positive finite number',
		);
		expect(() => prepareNodeUpdates(nodes, indices, [{ id: "a", strokeWidth: -1 }])).toThrow(
			'Node "a" must have a finite non-negative strokeWidth',
		);
		expect(() => prepareNodeUpdates(nodes, indices, [{ id: "a", shape: "octagon" as "circle" }])).toThrow(
			'Node "a" shape must be one of',
		);
		expect(() => prepareNodeUpdates(nodes, indices, [{ id: "missing", size: 2 }])).toThrow(
			'Cannot update missing node: "missing"',
		);
		expect(() =>
			prepareNodeUpdates(nodes, indices, [
				{ id: "a", size: 2 },
				{ id: "a", size: 3 },
			]),
		).toThrow('Duplicate node update: "a"');
	});
});
