// Named import from graphology-types: graphology ships one CommonJS-typed .d.ts, so its default
// export resolves to a namespace under `moduleResolution: "nodenext"` and breaks consumers.
import type { AbstractGraph } from "graphology-types";

import type { GraphraumColor, GraphraumData, GraphraumNodeShape } from "./types";

export type GraphologyNodeAttributes = Record<string, unknown> & {
	color?: GraphraumColor;
	shape?: GraphraumNodeShape;
	size?: number;
	x?: number;
	y?: number;
	z?: number;
};

export type GraphologyEdgeAttributes = Record<string, unknown> & {
	color?: GraphraumColor;
};

export interface GraphologyRenderer<NodeAttributes, EdgeAttributes> {
	setData(data: GraphraumData<NodeAttributes, EdgeAttributes>): void;
}

function projectGraphology<
	NodeAttributes extends GraphologyNodeAttributes,
	EdgeAttributes extends GraphologyEdgeAttributes,
>(graph: AbstractGraph<NodeAttributes, EdgeAttributes>): GraphraumData<NodeAttributes, EdgeAttributes> {
	const nodes = graph.mapNodes((id, attributes) => ({
		attributes,
		color: attributes.color,
		id,
		position: { x: attributes.x ?? 0, y: attributes.y ?? 0, z: attributes.z },
		shape: attributes.shape,
		size: attributes.size,
	}));
	const edges = graph.mapEdges((id, attributes, source, target) => ({
		attributes,
		color: attributes.color,
		id,
		source,
		target,
	}));
	return { edges, nodes } as unknown as GraphraumData<NodeAttributes, EdgeAttributes>;
}

/** Projects a mutable Graphology graph into Graphraum and keeps the binding alive until disposed. */
export function bindGraphology<
	NodeAttributes extends GraphologyNodeAttributes,
	EdgeAttributes extends GraphologyEdgeAttributes,
>(
	renderer: GraphologyRenderer<NodeAttributes, EdgeAttributes>,
	graph: AbstractGraph<NodeAttributes, EdgeAttributes>,
): () => void {
	renderer.setData(projectGraphology(graph));
	let flushPending = false;
	let disposed = false;
	const flush = () => {
		flushPending = false;
		if (disposed) return;
		renderer.setData(projectGraphology(graph));
	};
	const schedule = () => {
		if (flushPending) return;
		flushPending = true;
		queueMicrotask(flush);
	};
	graph.on("nodeAttributesUpdated", schedule);
	graph.on("eachNodeAttributesUpdated", schedule);
	graph.on("nodeAdded", schedule);
	graph.on("nodeDropped", schedule);
	graph.on("edgeAdded", schedule);
	graph.on("edgeDropped", schedule);
	graph.on("edgeAttributesUpdated", schedule);
	graph.on("eachEdgeAttributesUpdated", schedule);
	graph.on("cleared", schedule);
	graph.on("edgesCleared", schedule);
	return () => {
		disposed = true;
		graph.off("nodeAttributesUpdated", schedule);
		graph.off("eachNodeAttributesUpdated", schedule);
		graph.off("nodeAdded", schedule);
		graph.off("nodeDropped", schedule);
		graph.off("edgeAdded", schedule);
		graph.off("edgeDropped", schedule);
		graph.off("edgeAttributesUpdated", schedule);
		graph.off("eachEdgeAttributesUpdated", schedule);
		graph.off("cleared", schedule);
		graph.off("edgesCleared", schedule);
	};
}
