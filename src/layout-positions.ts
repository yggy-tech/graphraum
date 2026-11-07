import type { PreparedNodeUpdate } from "./node-updates";
import type { GraphraumLayoutPositions, GraphraumNode } from "./types";

/** Validates worker-friendly XYZ layout buffers before positions reach the renderer. */
export function prepareLayoutPositions<NodeAttributes = undefined>(
	nodes: readonly GraphraumNode<NodeAttributes>[],
	nodeIndices: ReadonlyMap<string, number>,
	layout: GraphraumLayoutPositions,
): readonly PreparedNodeUpdate<NodeAttributes>[] {
	if (layout.positions.length !== layout.nodeIds.length * 3) {
		throw new Error("Layout positions must contain one XYZ triplet per node ID");
	}
	const seen = new Set<string>();
	return layout.nodeIds.map((id, index) => {
		if (seen.has(id)) throw new Error(`Duplicate layout node ID: "${id}"`);
		seen.add(id);
		const nodeIndex = nodeIndices.get(id);
		if (nodeIndex === undefined) throw new Error(`Cannot position missing node: "${id}"`);
		const current = nodes[nodeIndex];
		if (!current) throw new Error(`Cannot position missing node: "${id}"`);
		const offset = index * 3;
		const position = {
			x: layout.positions[offset] ?? Number.NaN,
			y: layout.positions[offset + 1] ?? Number.NaN,
			z: layout.positions[offset + 2] ?? Number.NaN,
		};
		for (const [axis, value] of Object.entries(position)) {
			if (!Number.isFinite(value)) throw new Error(`Layout node "${id}" has a non-finite ${axis} position`);
		}
		return {
			colorChanged: false,
			glowChanged: false,
			iconChanged: false,
			index: nodeIndex,
			next: { ...current, position },
			positionChanged: true,
			shapeChanged: false,
			sizeChanged: false,
			strokeChanged: false,
		};
	});
}
