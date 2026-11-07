import { describe, expect, test } from "vitest";

import { resolveNodeStroke } from "./node-stroke";
import { graphraumTheme } from "./theme";

describe("resolveNodeStroke", () => {
	test("defaults to zero width and the theme stroke color when strokeWidth is omitted", () => {
		expect(resolveNodeStroke({ id: "a", position: { x: 0, y: 0 } }, graphraumTheme)).toEqual({
			strokeColor: graphraumTheme.nodeStroke,
			strokeWidthUv: 0,
		});
	});

	test("treats a zero strokeWidth the same as an omitted one", () => {
		expect(resolveNodeStroke({ id: "a", position: { x: 0, y: 0 }, strokeWidth: 0 }, graphraumTheme)).toEqual({
			strokeColor: graphraumTheme.nodeStroke,
			strokeWidthUv: 0,
		});
	});

	test("converts a world-unit strokeWidth into a fraction of max(width, height)", () => {
		expect(resolveNodeStroke({ id: "a", position: { x: 0, y: 0 }, size: 10, strokeWidth: 1 }, graphraumTheme)).toEqual({
			strokeColor: graphraumTheme.nodeStroke,
			strokeWidthUv: 0.1,
		});
	});

	test("uses the larger axis when width and height differ", () => {
		const stroke = resolveNodeStroke(
			{ id: "a", height: 4, position: { x: 0, y: 0 }, strokeWidth: 2, width: 20 },
			graphraumTheme,
		);
		expect(stroke.strokeWidthUv).toBeCloseTo(0.1);
	});

	test("clamps an oversized strokeWidth to the maximum ring fraction", () => {
		const stroke = resolveNodeStroke({ id: "a", position: { x: 0, y: 0 }, size: 4, strokeWidth: 100 }, graphraumTheme);
		expect(stroke.strokeWidthUv).toBe(0.45);
	});

	test("prefers an explicit strokeColor over the theme default", () => {
		expect(
			resolveNodeStroke({ id: "a", position: { x: 0, y: 0 }, strokeColor: "#ff0000", strokeWidth: 1 }, graphraumTheme),
		).toEqual({ strokeColor: "#ff0000", strokeWidthUv: 0.25 });
	});

	test("propagates the resolveNodeAxes error for an invalid axis", () => {
		expect(() =>
			resolveNodeStroke({ id: "a", position: { x: 0, y: 0 }, strokeWidth: 1, width: 0 }, graphraumTheme),
		).toThrow('Node "a" width must be a positive finite number');
	});

	test("falls back to the style default width only when the node sets none", () => {
		const node = { id: "a", position: { x: 0, y: 0 }, size: 10 };
		expect(resolveNodeStroke(node, graphraumTheme, 2).strokeWidthUv).toBe(0.2);
		expect(resolveNodeStroke({ ...node, strokeWidth: 1 }, graphraumTheme, 2).strokeWidthUv).toBe(0.1);
		expect(resolveNodeStroke({ ...node, strokeWidth: 0 }, graphraumTheme, 2).strokeWidthUv).toBe(0);
	});
});
