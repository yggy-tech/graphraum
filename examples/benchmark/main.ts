import type { ForceSettings } from "../../src";
import {
	defineVisuals,
	Graphraum,
	type GraphraumEdgeDepth,
	type GraphraumEdgeMarker,
	type GraphraumEdgeMarkerEnd,
	type GraphraumEdgePath,
	type GraphraumEdgeStyle,
	type GraphraumMode,
	type GraphraumNodeShape,
	type GraphraumOptions,
	type GraphraumOverlay,
} from "../../src";
import { renderControls } from "./controls";
import {
	createFixture,
	type EdgeAttributes,
	type EdgeDistribution,
	type Encoding,
	type FixtureOptions,
	type NodeAttributes,
} from "./fixture";
import { measurePerformance, renderPerformanceChart } from "./performance";
import { renderDataList } from "./ui";

type LayoutName = "circle" | "force" | "force-live" | "grid";
type ScaleMode = "million-density" | "million-literal" | "standard";
type LayoutWorkerMessage =
	| { end: number; positions: Float32Array; run: number; type: "positions" }
	| { run: number; type: "complete" };

interface LabState extends FixtureOptions {
	antialias: boolean;
	edgeMarker: GraphraumEdgeMarker;
	edgeMarkerEnd: GraphraumEdgeMarkerEnd;
	edgePath: GraphraumEdgePath;
	edgeStyle: GraphraumEdgeStyle;
	edgeOpacity: number;
	edgeWidth: number;
	forceMaxFps: number;
	forceSettings: ForceSettings;
	layout: LayoutName;
	maxPixelRatio: number;
	maxVisibleEdges: number;
	maxVisibleNodes: number;
	mode: GraphraumMode;
	edgeDepth: GraphraumEdgeDepth;
	scaleMode: ScaleMode;
}

function requireElement<ElementType extends Element>(selector: string) {
	const element = document.querySelector<ElementType>(selector);
	if (!element) throw new Error(`Laboratory element not found: ${selector}`);
	return element;
}

const container = requireElement<HTMLElement>("#graph");
const controls = requireElement<HTMLFormElement>("#controls");
renderControls(controls);
const diagnostics = requireElement<HTMLElement>("#diagnostics");
const presentationProperties = requireElement<HTMLElement>("#presentation-properties");
const presentationSubtitle = requireElement<HTMLElement>("#presentation-subtitle");
const presentationTitle = requireElement<HTMLElement>("#presentation-title");
const status = requireElement<HTMLElement>("#status");
const updateNode = requireElement<HTMLButtonElement>("#update-node");
const performanceRun = requireElement<HTMLButtonElement>("#performance-run");
const performanceStatus = requireElement<HTMLElement>("#performance-status");
const performanceValues = requireElement<HTMLElement>("#performance-values");
const performanceChart = requireElement<SVGSVGElement>("#performance-chart");

function formValue(values: FormData, name: string) {
	const value = values.get(name);
	if (typeof value !== "string") throw new Error(`Missing laboratory control: ${name}`);
	return value;
}

function formNumber(values: FormData, name: string) {
	return Number(formValue(values, name));
}

function forceEdges(edges: readonly { source: string; target: string }[]) {
	const result = new Uint32Array(edges.length * 2);
	for (const [index, edge] of edges.entries()) {
		result[index * 2] = Number(edge.source.slice(5));
		result[index * 2 + 1] = Number(edge.target.slice(5));
	}
	return result;
}

function forceClusters(nodes: readonly { attributes: NodeAttributes }[]) {
	return Uint32Array.from(nodes, (node) => node.attributes.cluster);
}

function readState(): LabState {
	const values = new FormData(controls);
	const fixture = formValue(values, "fixture");
	const scaleMode: ScaleMode = fixture === "million-density" || fixture === "million-literal" ? fixture : "standard";
	return {
		antialias: values.has("antialias"),
		edgeDistribution: formValue(values, "topology") as EdgeDistribution,
		edgeColors: {
			mentions: formValue(values, "mentionsColor"),
			related: formValue(values, "relatedColor"),
		},
		edgeMarker: formValue(values, "edgeMarker") as GraphraumEdgeMarker,
		edgeMarkerEnd: formValue(values, "edgeMarkerEnd") as GraphraumEdgeMarkerEnd,
		edgeMultiplier: scaleMode === "million-density" ? 0.1 : scaleMode === "million-literal" ? 0 : 3,
		edgeOpacity: formNumber(values, "edgeOpacity"),
		edgePath: formValue(values, "edgePath") as GraphraumEdgePath,
		edgeStyle: formValue(values, "edgeStyle") as GraphraumEdgeStyle,
		edgeWidth: formNumber(values, "edgeWidth"),
		encoding: formValue(values, "encoding") as Encoding,
		forceMaxFps: formNumber(values, "forceMaxFps"),
		forceSettings: {
			centerAttraction: formNumber(values, "forceCenterAttraction"),
			damping: formNumber(values, "forceDamping"),
			linkDistance: formNumber(values, "forceLinkDistance"),
			repulsion: formNumber(values, "forceRepulsion"),
			springStrength: formNumber(values, "forceSpringStrength"),
		},
		glowNodes: formNumber(values, "glowNodes"),
		layout: formValue(values, "layout") as LayoutName,
		maxPixelRatio: formNumber(values, "maxPixelRatio"),
		maxVisibleEdges: 100_000,
		maxVisibleNodes: scaleMode === "million-density" ? 50_000 : scaleMode === "million-literal" ? 1_000_000 : 100_000,
		mode: formValue(values, "mode") as GraphraumMode,
		edgeDepth: formValue(values, "edgeDepth") as GraphraumEdgeDepth,
		nodeAspect: formNumber(values, "nodeAspect"),
		nodeColors: {
			concept: formValue(values, "conceptColor"),
			document: formValue(values, "documentColor"),
			person: formValue(values, "personColor"),
		},
		nodeCount: scaleMode === "standard" ? Number(fixture) : 1_000_000,
		nodeShapes: {
			concept: formValue(values, "conceptShape") as GraphraumNodeShape,
			document: formValue(values, "documentShape") as GraphraumNodeShape,
			person: formValue(values, "personShape") as GraphraumNodeShape,
		},
		nodeSize: formNumber(values, "nodeSize"),
		nodeStrokeColor: formValue(values, "nodeStrokeColor"),
		nodeStrokeWidth: formNumber(values, "nodeStrokeWidth"),
		scoreSize: formNumber(values, "scoreSize"),
		scaleMode,
	};
}

let state = readState();
let graph: Graphraum<NodeAttributes, EdgeAttributes>;
let overlay: GraphraumOverlay<NodeAttributes, EdgeAttributes> | undefined;
let layoutRun = 0;
let liveFittedRun = -1;
let updateCount = 0;
let selectedNodeId: string | null = null;
const layoutWorker = new Worker(new URL("./layout-worker.ts", import.meta.url), { type: "module" });

const visuals = defineVisuals<NodeAttributes, EdgeAttributes>({
	node: (node) => ({
		presentation: {
			properties: [
				{ id: "cluster", label: "Cluster", value: node.attributes.cluster },
				{ id: "kind", label: "Kind", value: node.attributes.kind },
				{ id: "score", label: "Score", value: node.attributes.score },
				{ id: "theme", label: "Theme fallback", value: node.attributes.useTheme },
			],
			subtitle: `Typed ${node.attributes.kind} presentation`,
			title: `${node.attributes.kind} ${node.id}`,
		},
		...(state.encoding === "mapper"
			? {
					visual: {
						...(node.attributes.useTheme
							? {}
							: {
									color: state.nodeColors[node.attributes.kind],
									strokeColor: state.nodeStrokeColor,
									strokeWidth: state.nodeStrokeWidth,
								}),
						...(node.attributes.glow > 0 ? { glow: node.attributes.glow } : {}),
						height: state.nodeSize + node.attributes.score * state.scoreSize,
						shape: state.nodeShapes[node.attributes.kind],
						width: (state.nodeSize + node.attributes.score * state.scoreSize) * state.nodeAspect,
					},
				}
			: {}),
	}),
	edge: (edge) => ({
		presentation: {
			properties: [
				{ id: "kind", label: "Kind", value: edge.attributes.kind },
				{ id: "theme", label: "Theme fallback", value: edge.attributes.useTheme },
			],
			title: `${edge.attributes.kind} ${edge.id}`,
		},
		...(state.encoding === "mapper" && !edge.attributes.useTheme
			? {
					visual: {
						color: state.edgeColors[edge.attributes.kind],
						marker: state.edgeMarker,
						markerEnd: state.edgeMarkerEnd,
						opacity: state.edgeOpacity,
						path: state.edgePath,
						style: state.edgeStyle,
						width: state.edgeWidth,
					},
				}
			: {}),
	}),
});

function renderDiagnostics() {
	const values = graph.getDiagnostics();
	renderDataList(diagnostics, [
		["Draw calls", values.gpuDrawCalls],
		["GPU resources", `${values.gpuGeometries} geo · ${values.gpuTextures} tex`],
		["LOD", values.lodLevel],
		["Picking", values.pickingStrategy],
		["Visible nodes", `${values.visibleNodes.toLocaleString()} / ${values.totalNodes.toLocaleString()}`],
		["Glow halos", values.visibleGlowNodes.toLocaleString()],
		["Edge candidates", values.visibleEdgeCandidates.toLocaleString()],
		["Visible edges", `${values.visibleEdges.toLocaleString()} / ${values.totalEdges.toLocaleString()}`],
		["Visible edge markers", values.visibleEdgeMarkers.toLocaleString()],
	]);
}

performanceRun.addEventListener("click", async () => {
	performanceRun.disabled = true;
	performanceStatus.textContent = "Warming up and measuring 120 rendered frames…";
	try {
		const result = await measurePerformance(graph, 120, (samples) => {
			if (samples.length % 4 === 0) renderPerformanceChart(performanceChart, samples);
		});
		renderDataList(performanceValues, [
			["FPS", result.fps.toFixed(1)],
			["Frame p95", `${result.frameP95Milliseconds.toFixed(2)} ms`],
			["CPU render", `${result.cpuMeanMilliseconds.toFixed(2)} ms`],
			[
				"GPU render",
				result.gpuMeanMilliseconds === null ? "unsupported" : `${result.gpuMeanMilliseconds.toFixed(2)} ms`,
			],
			["Long-task share", `${(result.longTaskShare * 100).toFixed(1)}%`],
		]);
		renderPerformanceChart(performanceChart, result.samples);
		performanceStatus.textContent = `Complete · ${result.samples.length} samples · 10 warm-up frames`;
	} finally {
		performanceRun.disabled = false;
	}
});

function renderPresentation(kind: "Edge" | "Node", id: string) {
	const presentation = kind === "Node" ? graph.getNodePresentation(id) : graph.getEdgePresentation(id);
	if (!presentation) return;
	presentationTitle.textContent = presentation.title;
	presentationSubtitle.textContent = presentation.subtitle ?? `Compiled ${kind.toLowerCase()} presentation`;
	renderDataList(
		presentationProperties,
		presentation.properties.map((property) => [`${property.label} · ${property.id}`, String(property.value)]),
	);
}

function labelNodeIds(selectedNodeId?: string) {
	return [
		...Array.from({ length: Math.min(state.nodeCount, 8) }, (_, index) => `node-${index}`),
		...(selectedNodeId ? [selectedNodeId] : []),
	];
}

function createOverlay() {
	overlay = graph.createOverlay({
		renderLabel: ({ id, presentation }) => {
			const label = document.createElement("span");
			label.className = "graph-label";
			label.textContent = presentation?.title ?? id;
			return label;
		},
	});
	overlay.setLabels(labelNodeIds());
}

function graphOptions(): GraphraumOptions<NodeAttributes, EdgeAttributes> {
	return {
		antialias: state.antialias,
		maxPixelRatio: state.maxPixelRatio,
		maxVisibleEdges: state.maxVisibleEdges,
		maxVisibleNodes: state.maxVisibleNodes,
		mode: state.mode,
		scene: { edgeDepth: state.edgeDepth },
		visuals,
	};
}

function applyLayoutProgressively(
	layout: LayoutName,
	edges: readonly { source: string; target: string }[],
	nodes: readonly { attributes: NodeAttributes }[],
) {
	if (state.scaleMode !== "standard" && layout === "force-live") {
		status.textContent = "Live force is disabled for million-node fixtures; use the static density layout.";
		return;
	}
	if (state.scaleMode === "million-literal" && layout === "force") {
		status.textContent = "Force layout is disabled for the literal million-node stress fixture.";
		return;
	}
	const run = ++layoutRun;
	status.textContent = `Computing ${layout} layout in worker`;
	const packedEdges = layout === "force" || layout === "force-live" ? forceEdges(edges) : undefined;
	const clusters = layout === "force" && state.scaleMode === "million-density" ? forceClusters(nodes) : undefined;
	const transfer = [packedEdges?.buffer, clusters?.buffer].filter(
		(buffer): buffer is ArrayBuffer => buffer !== undefined,
	);
	layoutWorker.postMessage(
		{
			batchSize: Math.max(1_000, Math.ceil(state.nodeCount / 8)),
			clusters,
			dimensions: state.mode === "2d" ? 2 : 3,
			edges: packedEdges,
			maxFps: state.forceMaxFps,
			layout,
			nodeCount: state.nodeCount,
			run,
			settings: state.forceSettings,
			type: "start",
		},
		transfer,
	);
}

layoutWorker.addEventListener("message", ({ data }: MessageEvent<LayoutWorkerMessage>) => {
	if (data.run !== layoutRun) return;
	if (data.type === "positions") {
		const start = data.end - data.positions.length / 3;
		const nodeIds = Array.from({ length: data.positions.length / 3 }, (_, index) => `node-${start + index}`);
		graph.applyLayout({ nodeIds, positions: data.positions });
		if (state.layout === "force-live" && liveFittedRun !== data.run) {
			liveFittedRun = data.run;
			graph.fitView();
		}
		status.textContent = `Applying ${state.layout} layout · ${data.end.toLocaleString()} / ${state.nodeCount.toLocaleString()} nodes`;
		if (state.layout !== "force-live") {
			requestAnimationFrame(() => {
				if (data.run === layoutRun) layoutWorker.postMessage({ run: data.run, type: "next" });
			});
		}
		return;
	}
	graph.fitView();
	const encoding = state.encoding === "mapper" ? "typed mapper" : "direct snapshot";
	status.textContent = `${state.nodeCount.toLocaleString()} nodes · ${(state.nodeCount * state.edgeMultiplier).toLocaleString()} edges · ${state.mode.toUpperCase()} · ${encoding} · ${state.layout}`;
	requestAnimationFrame(renderDiagnostics);
});

window.addEventListener("beforeunload", () => layoutWorker.terminate());

function rebuild() {
	layoutRun += 1;
	liveFittedRun = -1;
	state = readState();
	overlay?.destroy();
	graph?.destroy();
	graph = new Graphraum<NodeAttributes, EdgeAttributes>(container, graphOptions());
	const data = createFixture(state);
	graph.setData(data);
	createOverlay();
	const encodingLabel = state.encoding === "mapper" ? "typed mapper" : "direct snapshot";
	status.textContent = `${state.nodeCount.toLocaleString()} nodes · ${(state.nodeCount * state.edgeMultiplier).toLocaleString()} edges · ${state.mode.toUpperCase()} · ${encodingLabel}`;
	presentationTitle.textContent = "No node selected";
	presentationSubtitle.textContent = "Choose a node in the viewport to inspect its compiled metadata.";
	presentationProperties.replaceChildren();
	selectedNodeId = null;
	updateNode.disabled = true;
	requestAnimationFrame(renderDiagnostics);
	if (state.layout !== "grid") applyLayoutProgressively(state.layout, data.edges, data.nodes);
}

controls.addEventListener("change", rebuild);

container.addEventListener("click", (event) => {
	const selectedNode = graph.pick(event.clientX, event.clientY);
	graph.setSelection(selectedNode ? [selectedNode] : []);
	selectedNodeId = selectedNode;
	updateNode.disabled = selectedNode === null || state.encoding !== "snapshot";
	overlay?.setLabels(labelNodeIds(selectedNode ?? undefined));
	if (selectedNode) renderPresentation("Node", selectedNode);
	requestAnimationFrame(renderDiagnostics);
});

for (const eventName of ["pointerup", "wheel"]) {
	container.addEventListener(eventName, () => requestAnimationFrame(renderDiagnostics));
}

requireElement<HTMLButtonElement>("#fit").addEventListener("click", () => {
	graph.fitView();
	requestAnimationFrame(renderDiagnostics);
});

requireElement<HTMLButtonElement>("#inspect-edge").addEventListener("click", () => {
	renderPresentation("Edge", "edge-0");
});

updateNode.addEventListener("click", () => {
	if (!selectedNodeId || state.encoding !== "snapshot") {
		status.textContent = "Select a node in direct snapshot mode before editing.";
		return;
	}
	updateCount += 1;
	graph.updateNodes([
		{
			color: updateCount % 2 === 0 ? state.nodeColors.concept : "#ff4d8d",
			id: selectedNodeId,
			position: { x: updateCount % 2 === 0 ? 0 : 24, y: 0, z: 0 },
			shape: updateCount % 2 === 0 ? state.nodeShapes.concept : "square",
			size: updateCount % 2 === 0 ? state.nodeSize : state.nodeSize * 2,
		},
	]);
	graph.setSelection([selectedNodeId]);
	overlay?.setLabels(labelNodeIds(selectedNodeId));
	renderPresentation("Node", selectedNodeId);
	requestAnimationFrame(renderDiagnostics);
});

rebuild();
