import { type BufferGeometry, type InstancedBufferAttribute, InstancedMesh, Scene } from "three";

import { createEdgeGeometry, createEdgeMesh, EDGE_INSTANCE_ATTRIBUTES, getInstancedAttribute } from "./edge-rendering";
import type { VisibleEdgeLayout } from "./edge-viewport-patch";
import { allocateNodeInstanceColors, createNodeGeometry } from "./node-rendering";
import { RADIAL_CRISP_EDGE_SLOT_LIMIT, RADIAL_CRISP_NODE_LIMIT } from "./radial-focus";

const NODE_INSTANCE_ATTRIBUTES = [
	"instanceShape",
	"instanceLens",
	"instanceIcon",
	"instanceStrokeWidth",
	"instanceStrokeColor",
	"instanceBlendA",
	"instanceBlendB",
] as const;

/** Copies instance `from` of `source` to instance `to` of `target`, for each attribute name. */
function copyInstance(
	source: BufferGeometry,
	target: BufferGeometry,
	names: readonly string[],
	from: number,
	to: number,
) {
	for (const name of names) {
		const read = getInstancedAttribute(source, name);
		const write = getInstancedAttribute(target, name);
		const size = read.itemSize;
		write.array.set(read.array.subarray(from * size, (from + 1) * size), to * size);
	}
}

type Slice = ArrayLike<number> & { subarray(start: number, end: number): ArrayLike<number> };

function copySlice(
	source: Slice,
	target: { set(values: ArrayLike<number>, offset: number): void },
	size: number,
	from: number,
	to: number,
) {
	target.set(source.subarray(from * size, (from + 1) * size), to * size);
}

function markWritten(attribute: InstancedBufferAttribute, instances: number) {
	attribute.clearUpdateRanges();
	attribute.addUpdateRange(0, Math.max(instances, 1) * attribute.itemSize);
	attribute.needsUpdate = true;
}

/**
 * The few nodes and edges that stay crisp while the radial focus blurs the rest, kept as their own
 * small meshes that borrow the real materials. They are rewritten from the real instances every
 * frame, so a running layout, a drag, the focus lens and state colours reach them with no extra
 * bookkeeping, and the cost follows the crisp set, not the graph.
 */
export class RadialCrispLayer {
	readonly scene = new Scene();
	private nodeMesh: InstancedMesh | null = null;
	private edgeMesh: InstancedMesh | null = null;

	/**
	 * Rewrites the crisp meshes from `source`. `nodeSlots` are instance slots of the node mesh and
	 * `edgeLayouts` the slot ranges of the edges to copy. Returns how many instances were drawn.
	 */
	sync(
		source: { edgeMesh: InstancedMesh | null; nodeMesh: InstancedMesh },
		nodeSlots: readonly number[],
		edgeLayouts: readonly VisibleEdgeLayout[],
	): number {
		const nodes = this.syncNodes(source.nodeMesh, nodeSlots);
		const edges = source.edgeMesh ? this.syncEdges(source.edgeMesh, edgeLayouts) : this.hideEdges();
		return nodes + edges;
	}

	dispose() {
		for (const mesh of [this.nodeMesh, this.edgeMesh]) {
			mesh?.geometry.dispose();
			mesh?.dispose();
		}
		this.scene.clear();
		this.nodeMesh = null;
		this.edgeMesh = null;
	}

	private syncNodes(source: InstancedMesh, slots: readonly number[]): number {
		const mesh = this.nodeMesh ?? this.createNodeMesh(source);
		const count = Math.min(slots.length, RADIAL_CRISP_NODE_LIMIT);
		mesh.material = source.material;
		mesh.renderOrder = source.renderOrder;
		const sourceColor = source.instanceColor;
		const targetColor = mesh.instanceColor;
		for (let to = 0; to < count; to += 1) {
			const from = slots[to] ?? 0;
			copySlice(source.instanceMatrix.array, mesh.instanceMatrix.array, 16, from, to);
			if (sourceColor && targetColor) copySlice(sourceColor.array, targetColor.array, 3, from, to);
			copyInstance(source.geometry, mesh.geometry, NODE_INSTANCE_ATTRIBUTES, from, to);
		}
		mesh.count = count;
		markWritten(mesh.instanceMatrix, count);
		if (targetColor) markWritten(targetColor, count);
		for (const name of NODE_INSTANCE_ATTRIBUTES) markWritten(getInstancedAttribute(mesh.geometry, name), count);
		return count;
	}

	private syncEdges(source: InstancedMesh, layouts: readonly VisibleEdgeLayout[]): number {
		const mesh = this.edgeMesh ?? this.createEdgeMesh(source);
		mesh.material = source.material;
		mesh.renderOrder = source.renderOrder;
		let to = 0;
		const copyRange = (start: number, count: number) => {
			for (let from = start; from < start + count && to < RADIAL_CRISP_EDGE_SLOT_LIMIT; from += 1) {
				copyInstance(source.geometry, mesh.geometry, EDGE_INSTANCE_ATTRIBUTES, from, to);
				to += 1;
			}
		};
		for (const layout of layouts) {
			if (layout.segmentCount > 0) copyRange(layout.segmentStart, layout.segmentCount);
			if (layout.markerCount > 0) copyRange(layout.markerStart, layout.markerCount);
		}
		mesh.count = to;
		for (const name of EDGE_INSTANCE_ATTRIBUTES) markWritten(getInstancedAttribute(mesh.geometry, name), to);
		return to;
	}

	private hideEdges(): number {
		if (this.edgeMesh) this.edgeMesh.count = 0;
		return 0;
	}

	private createNodeMesh(source: InstancedMesh): InstancedMesh {
		const mesh = new InstancedMesh(
			createNodeGeometry(RADIAL_CRISP_NODE_LIMIT),
			source.material,
			RADIAL_CRISP_NODE_LIMIT,
		);
		allocateNodeInstanceColors(mesh, RADIAL_CRISP_NODE_LIMIT);
		mesh.frustumCulled = false;
		this.nodeMesh = mesh;
		this.scene.add(mesh);
		return mesh;
	}

	private createEdgeMesh(source: InstancedMesh): InstancedMesh {
		const mesh = createEdgeMesh(
			createEdgeGeometry(RADIAL_CRISP_EDGE_SLOT_LIMIT),
			source.material as Parameters<typeof createEdgeMesh>[1],
		);
		mesh.frustumCulled = false;
		this.edgeMesh = mesh;
		this.scene.add(mesh);
		return mesh;
	}
}
