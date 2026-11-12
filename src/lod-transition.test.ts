import { describe, expect, test } from "vitest";
import { buildClusterTree } from "./cluster-tree";
import { clusterKey, MINIMUM_SCALE, nodeKey, planTransition, sampleTransition } from "./lod-transition";
import { scatter } from "./test-support/cluster-fixtures";

const tree = buildClusterTree({ dimensions: 2, positions: scatter(2000, 2) });
const centroid = (cluster: number) => ({
	x: tree.centroid[cluster * 2] as number,
	y: tree.centroid[cluster * 2 + 1] as number,
	z: 0,
});
const children = (cluster: number) =>
	Array.from(
		{ length: tree.childCount[cluster] as number },
		(_, offset) => (tree.childStart[cluster] as number) + offset,
	);
const none = { clusters: new Set<number>(), nodes: new Set<number>() };

describe("planTransition", () => {
	const parent = children(0)[0] as number;
	const kids = children(parent);

	test("a split sends the children out of the parent and shrinks the parent in place", () => {
		const plan = planTransition(
			tree,
			{ ...none, clusters: new Set([parent]) },
			{ ...none, clusters: new Set(kids) },
			centroid,
		);
		expect(plan.entering.map((entry) => entry.key).sort()).toEqual(kids.map(clusterKey).sort());
		expect(plan.entering.every((entry) => entry.from.x === centroid(parent).x)).toBe(true);
		expect(plan.leaving).toEqual([{ key: clusterKey(parent), to: null }]);
		expect(plan.growing).toEqual([]);
	});

	test("a merge sends the children into the parent while it grows", () => {
		const plan = planTransition(
			tree,
			{ ...none, clusters: new Set(kids) },
			{ ...none, clusters: new Set([parent]) },
			centroid,
		);
		expect(plan.growing).toEqual([clusterKey(parent)]);
		expect(plan.leaving.map((entry) => entry.key).sort()).toEqual(kids.map(clusterKey).sort());
		expect(plan.leaving.every((entry) => entry.to?.x === centroid(parent).x)).toBe(true);
		expect(plan.entering).toEqual([]);
	});

	test("real nodes split out of a leaf cluster and merge back into it", () => {
		const leaf = tree.leafOf[0] as number;
		const members = Array.from(
			tree.order.subarray(
				tree.memberStart[leaf],
				(tree.memberStart[leaf] as number) + (tree.memberCount[leaf] as number),
			),
		);
		const split = planTransition(
			tree,
			{ ...none, clusters: new Set([leaf]) },
			{ ...none, nodes: new Set(members) },
			centroid,
		);
		expect(split.entering.map((entry) => entry.key).sort()).toEqual(members.map(nodeKey).sort());
		const merge = planTransition(
			tree,
			{ ...none, nodes: new Set(members) },
			{ ...none, clusters: new Set([leaf]) },
			centroid,
		);
		expect(merge.leaving).toHaveLength(members.length);
		expect(merge.growing).toEqual([clusterKey(leaf)]);
	});

	test("elements that only enter or leave are not animated", () => {
		const other = children(0)[1] as number;
		const plan = planTransition(
			tree,
			{ ...none, clusters: new Set([parent]) },
			{ ...none, clusters: new Set([other]) },
			centroid,
		);
		expect(plan).toEqual({ entering: [], growing: [], leaving: [] });
	});

	test("an unchanged cut has an empty plan", () => {
		const cut = { ...none, clusters: new Set([parent]) };
		expect(planTransition(tree, cut, cut, centroid)).toEqual({ entering: [], growing: [], leaving: [] });
	});
});

describe("sampleTransition", () => {
	const parent = children(0)[0] as number;
	const kids = children(parent);
	const plan = planTransition(
		tree,
		{ ...none, clusters: new Set([parent]) },
		{ ...none, clusters: new Set(kids) },
		centroid,
	);
	const place = (key: string) => centroid(Number(key.slice(1)));

	test("starts at the parent, small, and ends in place at full size", () => {
		const start = sampleTransition(plan, 0, place);
		const end = sampleTransition(plan, 1, place);
		const child = kids[0] as number;
		const first = start.find((entry) => entry.key === clusterKey(child));
		const last = end.find((entry) => entry.key === clusterKey(child));
		expect(first?.position.x).toBeCloseTo(centroid(parent).x, 5);
		expect(first?.scale).toBeCloseTo(MINIMUM_SCALE, 5);
		expect(last?.position.x).toBeCloseTo(centroid(child).x, 5);
		expect(last?.scale).toBeCloseTo(1, 5);
	});

	test("the leaving parent shrinks to the minimum and never reaches zero", () => {
		const scales = [0, 0.25, 0.5, 0.75, 1].map(
			(progress) =>
				sampleTransition(plan, progress, place).find((entry) => entry.key === clusterKey(parent))?.scale ?? 0,
		);
		for (let index = 1; index < scales.length; index += 1)
			expect(scales[index]).toBeLessThanOrEqual(scales[index - 1] as number);
		expect(scales.at(-1)).toBeCloseTo(MINIMUM_SCALE, 5);
	});

	test("progress outside 0..1 is clamped", () => {
		expect(sampleTransition(plan, -3, place)).toEqual(sampleTransition(plan, 0, place));
		expect(sampleTransition(plan, 9, place)).toEqual(sampleTransition(plan, 1, place));
	});
});
