import { assertEdgeVisual } from "./edge-styles";
import { assertNodeGlow } from "./node-glow";
import { assertNodeIcon } from "./node-icon";
import { assertNodeShape } from "./node-shapes";
import type {
	CompiledGraphraumPresentation,
	GraphraumData,
	GraphraumEdgeVisual,
	GraphraumNodeVisual,
	GraphraumPresentation,
	GraphraumVisualMapper,
} from "./types";

export interface CompiledGraph {
	edgeNodeIndices: Uint32Array;
	edgePositions: Float32Array;
	edgePresentations: Map<string, CompiledGraphraumPresentation>;
	edgeVisuals: readonly Readonly<GraphraumEdgeVisual>[];
	incidentEdgeIndices: readonly (readonly number[])[];
	nodeIds: readonly string[];
	nodeIndices: Map<string, number>;
	nodePositions: Float32Array;
	nodePresentations: Map<string, CompiledGraphraumPresentation>;
	nodeVisuals: readonly Readonly<GraphraumNodeVisual>[];
}

function assertFinitePosition(nodeId: string, axis: string, value: number) {
	if (!Number.isFinite(value)) throw new Error(`Node "${nodeId}" has a non-finite ${axis} position`);
}

function assertNotEmpty(value: string, message: string) {
	if (value.trim().length === 0) throw new Error(message);
}

function compilePresentation(
	kind: "Edge" | "Node",
	id: string,
	presentation: GraphraumPresentation,
): CompiledGraphraumPresentation {
	const prefix = `${kind} "${id}" presentation`;
	assertNotEmpty(presentation.title, `${prefix} title must not be empty`);
	if (presentation.subtitle !== undefined) {
		assertNotEmpty(presentation.subtitle, `${prefix} subtitle must not be empty`);
	}

	const propertyIds = new Set<string>();
	const properties = (presentation.properties ?? []).map((property) => {
		assertNotEmpty(property.id, `${prefix} property id must not be empty`);
		assertNotEmpty(property.label, `${prefix} property "${property.id}" label must not be empty`);
		if (propertyIds.has(property.id)) throw new Error(`${prefix} has duplicate property id "${property.id}"`);
		propertyIds.add(property.id);
		if (typeof property.value === "number" && !Number.isFinite(property.value)) {
			throw new Error(`${prefix} property "${property.id}" must have a finite numeric value`);
		}
		if (
			property.value !== null &&
			!(["boolean", "number", "string"] as const).includes(typeof property.value as "boolean" | "number" | "string")
		) {
			throw new Error(`${prefix} property "${property.id}" must have a serializable scalar value`);
		}
		return Object.freeze({ ...property });
	});

	const actionIds = new Set<string>();
	const actions = (presentation.actions ?? []).map((action) => {
		assertNotEmpty(action.id, `${prefix} action id must not be empty`);
		assertNotEmpty(action.label, `${prefix} action "${action.id}" label must not be empty`);
		if (action.disabled !== undefined && typeof action.disabled !== "boolean") {
			throw new Error(`${prefix} action "${action.id}" disabled must be a boolean`);
		}
		if (actionIds.has(action.id)) throw new Error(`${prefix} has duplicate action id "${action.id}"`);
		actionIds.add(action.id);
		return Object.freeze({ ...action });
	});

	return Object.freeze({
		...presentation,
		actions: Object.freeze(actions),
		properties: Object.freeze(properties),
	});
}

function assertPositiveFiniteVisual(id: string, field: string, value: number | undefined): void {
	if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
		throw new Error(`Node "${id}" visual must have a positive finite ${field}`);
	}
}

function assertNonNegativeFiniteVisual(id: string, field: string, value: number | undefined): void {
	if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
		throw new Error(`Node "${id}" visual must have a finite non-negative ${field}`);
	}
}

/** Validates and freezes `visual` in place; callers pass an object they own. */
function compileNodeVisual(id: string, visual: GraphraumNodeVisual): Readonly<GraphraumNodeVisual> {
	assertPositiveFiniteVisual(id, "size", visual.size);
	assertPositiveFiniteVisual(id, "width", visual.width);
	assertPositiveFiniteVisual(id, "height", visual.height);
	assertNonNegativeFiniteVisual(id, "strokeWidth", visual.strokeWidth);
	assertNodeGlow(id, visual.glow);
	assertNodeIcon(id, visual.icon);
	if (visual.shape !== undefined) assertNodeShape(id, visual.shape);
	return Object.freeze(visual);
}

function compileEdgeVisual(id: string, visual: GraphraumEdgeVisual): Readonly<GraphraumEdgeVisual> {
	assertEdgeVisual(id, visual);
	return Object.freeze(visual);
}

const EDGE_VISUAL_KEYS = [
	"color",
	"width",
	"opacity",
	"style",
	"marker",
	"markerSize",
	"markerEnd",
	"path",
	"controlPoints",
] as const satisfies readonly (keyof GraphraumEdgeVisual)[];

/** Validates graph identity and compiles lookup-heavy objects into GPU-oriented position buffers. */
export function compileGraph<NodeAttributes = undefined, EdgeAttributes = undefined>(
	data: GraphraumData<NodeAttributes, EdgeAttributes>,
	visuals?: GraphraumVisualMapper<NodeAttributes, EdgeAttributes>,
): CompiledGraph {
	const nodeCount = data.nodes.length;
	const edgeCount = data.edges.length;
	const nodeIndices = new Map<string, number>();
	const nodePositions = new Float32Array(nodeCount * 3);
	const nodePresentations = new Map<string, CompiledGraphraumPresentation>();
	const nodeVisuals: Readonly<GraphraumNodeVisual>[] = new Array(nodeCount);
	const nodeIds: string[] = new Array(nodeCount);

	for (let index = 0; index < nodeCount; index += 1) {
		const node = data.nodes[index] as (typeof data.nodes)[number];
		if (nodeIndices.has(node.id)) throw new Error(`Duplicate node id: "${node.id}"`);
		const z = node.position.z ?? 0;
		assertFinitePosition(node.id, "x", node.position.x);
		assertFinitePosition(node.id, "y", node.position.y);
		assertFinitePosition(node.id, "z", z);
		const encoding = visuals?.node?.(node);
		nodeVisuals[index] = compileNodeVisual(
			node.id,
			(encoding?.visual && { ...encoding.visual }) || {
				color: node.color,
				glow: node.glow,
				height: node.height,
				icon: node.icon,
				shape: node.shape,
				size: node.size,
				strokeColor: node.strokeColor,
				strokeWidth: node.strokeWidth,
				width: node.width,
			},
		);
		if (encoding?.presentation) {
			nodePresentations.set(node.id, compilePresentation("Node", node.id, encoding.presentation));
		}

		nodeIds[index] = node.id;
		nodeIndices.set(node.id, index);
		nodePositions[index * 3] = node.position.x;
		nodePositions[index * 3 + 1] = node.position.y;
		nodePositions[index * 3 + 2] = z;
	}

	const edgeIds = new Set<string>();
	const edgeNodeIndices = new Uint32Array(edgeCount * 2);
	const edgePositions = new Float32Array(edgeCount * 6);
	const edgePresentations = new Map<string, CompiledGraphraumPresentation>();
	const edgeVisuals: Readonly<GraphraumEdgeVisual>[] = new Array(edgeCount);
	const incidentEdgeIndices: number[][] = new Array(nodeCount);
	for (let index = 0; index < nodeCount; index += 1) incidentEdgeIndices[index] = [];
	for (let index = 0; index < edgeCount; index += 1) {
		const edge = data.edges[index] as (typeof data.edges)[number];
		if (edgeIds.has(edge.id)) throw new Error(`Duplicate edge id: "${edge.id}"`);
		edgeIds.add(edge.id);
		const encoding = visuals?.edge?.(edge);
		// Edges that style themselves alike share one frozen visual; consumers copy it, never edit it.
		const previous = edgeVisuals[index - 1];
		if (!encoding?.visual && previous && EDGE_VISUAL_KEYS.every((key) => previous[key] === edge[key])) {
			edgeVisuals[index] = previous;
		} else {
			const visual: GraphraumEdgeVisual = {};
			for (const key of EDGE_VISUAL_KEYS) (visual as Record<string, unknown>)[key] = edge[key];
			Object.assign(visual, encoding?.visual);
			edgeVisuals[index] = compileEdgeVisual(edge.id, visual);
		}
		if (encoding?.presentation) {
			edgePresentations.set(edge.id, compilePresentation("Edge", edge.id, encoding.presentation));
		}

		const sourceIndex = nodeIndices.get(edge.source);
		const targetIndex = nodeIndices.get(edge.target);
		if (sourceIndex === undefined) throw new Error(`Edge "${edge.id}" references missing source "${edge.source}"`);
		if (targetIndex === undefined) throw new Error(`Edge "${edge.id}" references missing target "${edge.target}"`);
		edgeNodeIndices[index * 2] = sourceIndex;
		edgeNodeIndices[index * 2 + 1] = targetIndex;
		(incidentEdgeIndices[sourceIndex] as number[]).push(index);
		if (targetIndex !== sourceIndex) (incidentEdgeIndices[targetIndex] as number[]).push(index);

		for (let axis = 0; axis < 3; axis += 1) {
			edgePositions[index * 6 + axis] = nodePositions[sourceIndex * 3 + axis] as number;
			edgePositions[index * 6 + 3 + axis] = nodePositions[targetIndex * 3 + axis] as number;
		}
	}

	return {
		edgeNodeIndices,
		edgePositions,
		edgePresentations,
		edgeVisuals,
		incidentEdgeIndices,
		nodeIds,
		nodeIndices,
		nodePositions,
		nodePresentations,
		nodeVisuals,
	};
}
