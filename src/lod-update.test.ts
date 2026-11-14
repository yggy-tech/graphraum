import { describe, expect, it } from "vitest";
import { buildClusterTree } from "./cluster-tree";
import { drawnElementOf, sampleMorph, trackIsStill, voteDrawnElement } from "./lod-update";

const line = (count: number) => {
	const positions = new Float32Array(count * 2);
	for (let index = 0; index < count; index += 1) positions[index * 2] = index;
	return buildClusterTree({ dimensions: 2, leafSize: 4, positions });
};

describe("drawnElementOf", () => {
	const tree = line(32);

	it("names the node itself when the cut drew it", () => {
		expect(drawnElementOf(tree, { clusters: new Set(), nodes: new Set([5]) }, 5)).toBe("n5");
	});

	it("names the drawn cluster that holds the node", () => {
		expect(drawnElementOf(tree, { clusters: new Set([0]), nodes: new Set() }, 7)).toBe("c0");
	});

	it("knows nothing of nodes the tree did not have", () => {
		expect(drawnElementOf(tree, { clusters: new Set([0]), nodes: new Set() }, 40)).toBeNull();
	});
});

describe("voteDrawnElement", () => {
	it("picks the element most members came from and skips new members", () => {
		const elementOf = (index: number) => (index >= 10 ? null : index < 7 ? "c1" : "c2");
		expect(voteDrawnElement([0, 1, 2, 7, 8, 10, 11, 12, 13], elementOf)).toBe("c1");
	});

	it("is null when every member is new", () => {
		expect(voteDrawnElement([10, 11], () => null)).toBeNull();
	});
});

describe("sampleMorph", () => {
	const track = { from: { x: 0, y: 0, z: 0 }, fromScale: 0.5, id: "a", to: { x: 10, y: 20, z: 0 }, toScale: 1 };

	it("starts where it was and ends where the new tree puts it", () => {
		expect(sampleMorph(track, 0)).toEqual({ position: { x: 0, y: 0, z: 0 }, scale: 0.5 });
		expect(sampleMorph(track, 1)).toEqual({ position: { x: 10, y: 20, z: 0 }, scale: 1 });
		expect(sampleMorph(track, 0.5).position.x).toBeCloseTo(5);
	});

	it("knows a track that does not move", () => {
		expect(trackIsStill(track)).toBe(false);
		expect(trackIsStill({ ...track, from: track.to, fromScale: 1 })).toBe(true);
	});
});
