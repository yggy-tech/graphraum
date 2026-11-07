import { Texture } from "three";
import { describe, expect, test } from "vitest";

import { compileGraph } from "./compile-graph";
import { assertIconAtlas, assertIconScale, assertNodeIcon, assertNodeIconInAtlas } from "./node-icon";
import { prepareNodeUpdates } from "./node-updates";

describe("icon validation", () => {
	test("accepts no icon and non-negative integers", () => {
		expect(() => assertNodeIcon("a", undefined)).not.toThrow();
		expect(() => assertNodeIcon("a", 0)).not.toThrow();
		expect(() => assertNodeIcon("a", 12)).not.toThrow();
	});

	test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s with the node id", (icon) => {
		expect(() => assertNodeIcon("a", icon)).toThrow(/Node "a" icon must be a non-negative integer/);
	});

	test("names the atlas size when an index is out of range", () => {
		expect(() => assertNodeIconInAtlas("a", 3, 3)).toThrow(
			/icon 3 is outside the icon atlas, which has 3 icons \(0 to 2\)/,
		);
		expect(() => assertNodeIconInAtlas("a", 2, 3)).not.toThrow();
		expect(() => assertNodeIconInAtlas("a", undefined, 3)).not.toThrow();
	});

	test("checks the atlas description and scale", () => {
		const texture = new Texture();
		expect(() => assertIconAtlas({ columns: 2, count: 3, padding: 0.125, rows: 2, texture })).not.toThrow();
		expect(() => assertIconAtlas({ columns: 1, count: 3, padding: 0.125, rows: 2, texture })).toThrow(
			/hold every icon/,
		);
		expect(() => assertIconAtlas({ columns: 2, count: 3, padding: 0.5, rows: 2, texture })).toThrow(/padding/);
		expect(() => assertIconScale(0.6)).not.toThrow();
		expect(() => assertIconScale(0)).toThrow(/scale/);
	});

	test("graph compilation and updates reject a bad icon before anything changes", () => {
		expect(() => compileGraph({ edges: [], nodes: [{ icon: -2, id: "a", position: { x: 0, y: 0 } }] })).toThrow(/icon/);
		const nodes = [{ id: "a", position: { x: 0, y: 0 } }];
		expect(() => prepareNodeUpdates(nodes, new Map([["a", 0]]), [{ icon: 1.5, id: "a" }])).toThrow(/icon/);
		const [update] = prepareNodeUpdates(nodes, new Map([["a", 0]]), [{ icon: 2, id: "a" }]);
		expect(update).toMatchObject({ iconChanged: true, next: { icon: 2 } });
	});
});
