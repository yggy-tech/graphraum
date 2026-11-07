/** Styles entry (`@yggy-tech/graphraum/styles`): more look presets, kept out of the main bundle. */
import type { GraphraumLabelStyle, GraphraumStyle, GraphraumStyleName } from "./types";

// Applying a preset with `setStyle` merges, so every label field is named: an unset one clears the previous preset's.
const NO_LABEL: GraphraumLabelStyle = {
	bg: undefined,
	border: undefined,
	radius: undefined,
	fg: undefined,
	font: undefined,
	size: undefined,
	weight: undefined,
	padding: undefined,
};

// A copy of `graphraumThemes.dark` and `.light`: importing them would put the main theme module in a shared chunk.
const classicDark = {
	edge: { markerSize: 1 },
	label: NO_LABEL,
	node: { strokeWidth: 0 },
	theme: {
		background: "#040f0f",
		dimmedEdge: "#315a51",
		dimmedEdgeOpacity: 0.25,
		dimmedNode: "#315a51",
		edge: "#226f54",
		edgeOpacity: 0.55,
		edgeWidth: 1.5,
		endpointAttach: "boundary",
		focusedNode: "#73c7a5",
		hoveredNode: "#e4a853",
		node: "#226f54",
		nodeStroke: "#fcfffc",
		selectedEdge: "#fcfffc",
		selectedNode: "#fcfffc",
	},
} satisfies GraphraumStyle;

const classicLight = {
	...classicDark,
	theme: {
		background: "#fcfffc",
		dimmedEdge: "#9bb5ac",
		dimmedEdgeOpacity: 0.35,
		dimmedNode: "#9bb5ac",
		edge: "#226f54",
		edgeOpacity: 0.65,
		edgeWidth: 1.5,
		endpointAttach: "boundary",
		focusedNode: "#1a5c45",
		hoveredNode: "#c47a1a",
		node: "#226f54",
		nodeStroke: "#040f0f",
		selectedEdge: "#040f0f",
		selectedNode: "#040f0f",
	},
} satisfies GraphraumStyle;

/** Brand-free greys with blue hover and selection accents on a transparent canvas and a system font stack, so it sits on any host page. */
const neutral = {
	edge: { markerSize: 1 },
	label: {
		...NO_LABEL,
		radius: "4px",
		font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
		size: "12px",
		weight: "500",
		padding: "2px 6px",
	},
	node: { strokeWidth: 0 },
	theme: {
		background: null,
		dimmedEdge: "#c4c4cc",
		dimmedEdgeOpacity: 0.3,
		dimmedNode: "#c4c4cc",
		edge: "#8b8b94",
		edgeOpacity: 0.55,
		edgeWidth: 1.25,
		endpointAttach: "boundary",
		focusedNode: "#1d4ed8",
		hoveredNode: "#60a5fa",
		node: "#8b8b94",
		nodeStroke: "#ffffff",
		selectedEdge: "#2563eb",
		selectedNode: "#2563eb",
	},
} satisfies GraphraumStyle;

/** Dark blue drafting paper with light lines and monospace labels. */
const blueprint = {
	edge: { markerSize: 1.5 },
	label: {
		...NO_LABEL,
		bg: "rgba(11, 37, 69, 0.88)",
		radius: "2px",
		fg: "#dbe7f3",
		font: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
		size: "11px",
		weight: "400",
		padding: "2px 5px",
	},
	node: { strokeWidth: 1 },
	theme: {
		background: "#0b2545",
		dimmedEdge: "#35567d",
		dimmedEdgeOpacity: 0.35,
		dimmedNode: "#35567d",
		edge: "#dbe7f3",
		edgeOpacity: 0.55,
		edgeWidth: 1,
		endpointAttach: "boundary",
		focusedNode: "#7bdff2",
		hoveredNode: "#ffd166",
		node: "#8da9c4",
		nodeStroke: "#dbe7f3",
		selectedEdge: "#ffffff",
		selectedNode: "#ffffff",
	},
} satisfies GraphraumStyle;

/** `classicDark` is exactly today's default look. The default has not changed; these are opt-in. */
export const graphraumStylePresets = Object.freeze({
	blueprint,
	classicDark,
	classicLight,
	neutral,
} satisfies Record<GraphraumStyleName, GraphraumStyle>);
