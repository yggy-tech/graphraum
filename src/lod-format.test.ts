import { describe, expect, test } from "vitest";
import { buildClusterTree } from "./cluster-tree";
import { clusterFill, formatCount, labelFits, nodeColorKeys } from "./lod-format";
import { scatter } from "./test-support/cluster-fixtures";

describe("formatCount", () => {
	test.each([
		[7, "7"],
		[999, "999"],
		[1_000, "1k"],
		[1_234, "1.2k"],
		[9_949, "9.9k"],
		[34_100, "34k"],
		[999_900, "1M"],
		[1_234_567, "1.2M"],
		[12_000_000, "12M"],
	])("%i is %s", (count, text) => {
		expect(formatCount(count)).toBe(text);
	});
});

describe("labelFits", () => {
	test("hides the label when the glyph is too small to hold it", () => {
		expect(labelFits("1.2k", 8)).toBe(false);
		expect(labelFits("1.2k", 20)).toBe(true);
		expect(labelFits("34", 11)).toBe(true);
		expect(labelFits("1.2k", 20)).toBe(labelFits("1.2k", 20.5));
	});
});

describe("colour summary", () => {
	const count = 4000;
	const positions = scatter(count, 2);
	const palette = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00];
	const colors = Uint32Array.from({ length: count }, (_, node) => palette[node % 4] as number);
	const tree = buildClusterTree({ colors, dimensions: 2, positions });

	test("keeps the three most common colours with exact leaf counts", () => {
		expect(tree.colorKey).not.toBeNull();
		for (let cluster = 0; cluster < tree.clusterCount; cluster += 1) {
			if (tree.childCount[cluster] !== 0) continue;
			const tally = new Map<number, number>();
			for (const node of tree.order.subarray(
				tree.memberStart[cluster],
				(tree.memberStart[cluster] as number) + (tree.memberCount[cluster] as number),
			)) {
				tally.set(colors[node] as number, (tally.get(colors[node] as number) ?? 0) + 1);
			}
			const expected = [...tally.values()].sort((left, right) => right - left).slice(0, 3);
			const got = [0, 1, 2].map((slot) => tree.colorCount?.[cluster * 3 + slot] ?? 0).filter((value) => value > 0);
			expect(got).toEqual(expected);
		}
	});

	test("the root sees roughly equal shares", () => {
		const total = [0, 1, 2].reduce((sum, slot) => sum + (tree.colorCount?.[slot] ?? 0), 0);
		expect(total).toBeGreaterThan(count * 0.4);
		expect(total).toBeLessThanOrEqual(count);
	});

	test("has no summary without colours and rejects a wrong length", () => {
		expect(buildClusterTree({ dimensions: 2, positions }).colorKey).toBeNull();
		expect(() => buildClusterTree({ colors: new Uint32Array(3), dimensions: 2, positions })).toThrow(
			/one number per node/,
		);
	});

	test("a dominant colour is shown alone, a mixed cluster blends the top colours", () => {
		const mixed = clusterFill(tree, 0);
		expect(mixed.blend?.length).toBeGreaterThan(0);
		const same = buildClusterTree({ colors: new Uint32Array(count).fill(0x123456), dimensions: 2, positions });
		expect(clusterFill(same, 0)).toEqual({ color: "#123456" });
		expect(clusterFill(buildClusterTree({ dimensions: 2, positions }), 0)).toEqual({});
	});
});

describe("nodeColorKeys", () => {
	test("reads hex strings and numbers, anything else is neutral grey", () => {
		const keys = nodeColorKeys([{ color: "#ff0000" }, { color: "#0f0" }, { color: 0x112233 }, { color: "red" }, {}]);
		expect([...keys]).toEqual([0xff0000, 0x00ff00, 0x112233, 0x8a94a6, 0x8a94a6]);
	});
});
