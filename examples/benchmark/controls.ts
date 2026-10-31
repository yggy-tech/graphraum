import { DEFAULT_FORCE_SETTINGS, graphraumTheme } from "../../src";
import { Checkbox, Color, Field, Input, Section, Select, Slider } from "./ui";

const shapes = [
	{ label: "Circle", value: "circle" },
	{ label: "Square", value: "square" },
	{ label: "Diamond", value: "diamond" },
	{ label: "Hexagon", value: "hexagon" },
	{ label: "Triangle", value: "triangle" },
	{ label: "Pill", value: "pill" },
	{ label: "Rounded", value: "rounded" },
];

const edgeStyles = [
	{ label: "Solid", value: "solid" },
	{ label: "Dashed", value: "dashed" },
	{ label: "Dotted", value: "dotted" },
];

const edgeMarkers = [
	{ label: "None", value: "none" },
	{ label: "Triangle", value: "triangle" },
];

const edgeMarkerEnds = [
	{ label: "Target", value: "target" },
	{ label: "Source", value: "source" },
	{ label: "Both", value: "both" },
];

const edgePaths = [
	{ label: "Straight", value: "straight" },
	{ label: "Quadratic", value: "quadratic" },
	{ label: "Cubic", value: "cubic" },
];

function NumberField(label: string, name: string, value: number, min: number, max?: number, step?: number) {
	return Field(label, Input({ max, min, name, step, type: "number", value }));
}

function SelectField(label: string, name: string, value: string, options: readonly { label: string; value: string }[]) {
	return Field(label, Select(name, value, options));
}

function VisualField(label: string, shapeName: string, shape: string, colorName: string, color: string) {
	const field = document.createElement("div");
	field.className = "field field--visual";
	const name = document.createElement("span");
	name.textContent = label;
	const colorInput = Input({ name: colorName, type: "color", value: color });
	colorInput.ariaLabel = `${label} color`;
	field.append(name, Select(shapeName, shape, shapes), colorInput);
	return field;
}

export function renderControls(form: HTMLFormElement) {
	form.replaceChildren(
		Section(
			"Renderer",
			SelectField("Mode", "mode", "2d", [
				{ label: "2D", value: "2d" },
				{ label: "3D", value: "3d" },
			]),
			SelectField("Edge depth (3D)", "edgeDepth", "behind-nodes", [
				{ label: "Behind nodes", value: "behind-nodes" },
				{ label: "Scene", value: "scene" },
			]),
			SelectField("Shading (3D)", "shading", "flat", [
				{ label: "Flat", value: "flat" },
				{ label: "Lit", value: "lit" },
				{ label: "Toon", value: "toon" },
			]),
			Checkbox("Antialias", "antialias"),
			NumberField("Pixel ratio", "maxPixelRatio", 1, 0.5, 4, 0.5),
		),
		Section(
			"Graph",
			SelectField("Fixture", "fixture", "1000", [
				{ label: "100 nodes", value: "100" },
				{ label: "1,000 nodes", value: "1000" },
				{ label: "10,000 nodes", value: "10000" },
				{ label: "100,000 nodes", value: "100000" },
				{ label: "1M density LOD", value: "million-density" },
				{ label: "1M literal nodes", value: "million-literal" },
			]),
			SelectField("Encoding", "encoding", "mapper", [
				{ label: "Typed mapper", value: "mapper" },
				{ label: "Direct snapshot", value: "snapshot" },
			]),
			SelectField("Topology", "topology", "clustered", [
				{ label: "Clustered communities", value: "clustered" },
				{ label: "Uniform", value: "linear" },
			]),
			SelectField("Layout", "layout", "grid", [
				{ label: "Grid", value: "grid" },
				{ label: "Progressive circle", value: "circle" },
				{ label: "Force directed", value: "force" },
				{ label: "Live force directed", value: "force-live" },
			]),
			NumberField("Live force FPS", "forceMaxFps", 30, 1, 60, 1),
		),
		Section(
			"Appearance",
			Slider("Base size", "nodeSize", 3, 1, 12, 0.5),
			Slider("Score scale", "scoreSize", 4, 0, 10, 0.5),
			Slider("Aspect (width / height)", "nodeAspect", 1, 0.5, 2, 0.1),
			Slider("Stroke width", "nodeStrokeWidth", 0, 0, 2, 0.1),
			Color("Stroke color", "nodeStrokeColor", graphraumTheme.nodeStroke),
			NumberField("Glowing nodes", "glowNodes", 0, 0, 1_000, 1),
			VisualField("Concept", "conceptShape", "diamond", "conceptColor", "#e4a853"),
			VisualField("Document", "documentShape", "square", "documentColor", "#73c7a5"),
			VisualField("Person", "personShape", "circle", "personColor", "#fcfffc"),
			Color("Mentions edge", "mentionsColor", "#2d8b6a"),
			Color("Related edge", "relatedColor", "#226f54"),
			Slider("Edge width", "edgeWidth", graphraumTheme.edgeWidth, 0.5, 6, 0.25),
			Slider("Edge opacity", "edgeOpacity", graphraumTheme.edgeOpacity, 0, 1, 0.05),
			SelectField("Edge style", "edgeStyle", "solid", edgeStyles),
			SelectField("Edge path", "edgePath", "straight", edgePaths),
			SelectField("Edge marker", "edgeMarker", "none", edgeMarkers),
			SelectField("Marker end", "edgeMarkerEnd", "target", edgeMarkerEnds),
		),
		Section(
			"Force layout",
			NumberField("Repulsion", "forceRepulsion", DEFAULT_FORCE_SETTINGS.repulsion, 0, 5000, 25),
			NumberField("Link distance", "forceLinkDistance", DEFAULT_FORCE_SETTINGS.linkDistance, 1, 500, 1),
			NumberField(
				"Spring strength",
				"forceSpringStrength",
				DEFAULT_FORCE_SETTINGS.springStrength,
				0.0001,
				0.05,
				0.0005,
			),
			NumberField(
				"Center attraction",
				"forceCenterAttraction",
				DEFAULT_FORCE_SETTINGS.centerAttraction,
				0,
				0.05,
				0.0005,
			),
			NumberField("Damping", "forceDamping", DEFAULT_FORCE_SETTINGS.damping, 0.1, 0.99, 0.01),
		),
	);
}
