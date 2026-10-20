import {
	Graphraum,
	type GraphraumEdgeMarker,
	type GraphraumEdgeMarkerEnd,
	type GraphraumEdgePath,
	type GraphraumEdgeStyle,
	type GraphraumMode,
	type GraphraumNodeShape,
	type GraphraumOverlay,
} from "@yggy-tech/graphraum";

import {
	createPlaygroundFixture,
	createPlaygroundVisuals,
	defaultPlaygroundAppearance,
	type PlaygroundEdgeAttributes,
	type PlaygroundNodeAttributes,
	playgroundClusters,
} from "../lib/playground";
import { readPlaygroundForceControls } from "../lib/playground-force";
import { createPlaygroundOverlayOptions } from "../lib/playground-overlay";
import {
	createSceneUseCase,
	type DemoSceneId,
	resolveStressLayout,
	type StressLayout,
	type StressLayoutChoice,
	type StressSize,
} from "../lib/playground-scenes";
import { focusNode } from "../lib/scene-focus";
import { type DemoEdgeAttributes, type DemoNodeAttributes, type DemoUseCase, demoVisuals } from "../lib/use-case-demos";

type LayoutWorkerMessage =
	| { end: number; positions: Float32Array; run: number; type: "positions" }
	| { run: number; type: "complete" };

export type StageScene =
	| { kind: "demo"; graph: Graphraum<DemoNodeAttributes, DemoEdgeAttributes>; useCase: DemoUseCase }
	| { kind: "stress"; graph: Graphraum<PlaygroundNodeAttributes, PlaygroundEdgeAttributes>; size: StressSize }
	| { kind: "prove"; graph: Graphraum };

const theme = { background: "#06100f" };

function formValue(values: FormData, name: string) {
	const value = values.get(name);
	if (typeof value !== "string") throw new Error(`Missing playground setting: ${name}`);
	return value;
}

function packEdges(edges: readonly { source: string; target: string }[]) {
	const result = new Uint32Array(edges.length * 2);
	for (const [index, edge] of edges.entries()) {
		result[index * 2] = Number(edge.source.slice(5));
		result[index * 2 + 1] = Number(edge.target.slice(5));
	}
	return result;
}

/** Owns the one live graph on the page and the layout worker that feeds the stress scene. */
export class PlaygroundStage {
	current: StageScene | null = null;
	private overlay: Pick<GraphraumOverlay, "destroy"> | null = null;
	private worker: Worker | null = null;
	private layoutRun = 0;
	private liveFittedRun = -1;
	private layout: StressLayout = "grid";

	constructor(
		readonly container: HTMLElement,
		private readonly onLayoutProgress: (text: string) => void,
	) {}

	mountDemo(sceneId: DemoSceneId, mode: GraphraumMode) {
		this.clear();
		const useCase = createSceneUseCase(sceneId);
		const graph = new Graphraum(this.container, { maxPixelRatio: 2, mode, theme, visuals: demoVisuals });
		graph.setData(useCase.data);
		this.overlay = graph.createOverlay({
			labelClassName: "playground-overlay-label",
			labelPolicy: "focus",
			maxLabels: 16,
			renderLabel: ({ id, presentation }) => {
				const label = document.createElement("span");
				label.textContent = presentation?.title ?? id;
				return label;
			},
		});
		this.current = { graph, kind: "demo", useCase };
		return this.current;
	}

	mountStress(size: StressSize, mode: GraphraumMode, settings: FormData, onInspect: (nodeId: string) => void) {
		this.clear();
		const appearance = defaultPlaygroundAppearance();
		appearance.nodeCount = size;
		appearance.nodeAspect = Number(formValue(settings, "nodeAspect"));
		appearance.nodeStrokeWidth = Number(formValue(settings, "nodeStrokeWidth"));
		appearance.nodeShapes = {
			concept: formValue(settings, "conceptShape") as GraphraumNodeShape,
			document: formValue(settings, "documentShape") as GraphraumNodeShape,
			person: formValue(settings, "personShape") as GraphraumNodeShape,
		};
		appearance.edgePath = formValue(settings, "edgePath") as GraphraumEdgePath;
		appearance.edgeStyle = formValue(settings, "edgeStyle") as GraphraumEdgeStyle;
		appearance.edgeMarker = formValue(settings, "edgeMarker") as GraphraumEdgeMarker;
		appearance.edgeMarkerEnd = formValue(settings, "edgeMarkerEnd") as GraphraumEdgeMarkerEnd;
		appearance.edgeWidth = Number(formValue(settings, "edgeWidth"));
		appearance.edgeOpacity = Number(formValue(settings, "edgeOpacity"));

		const graph = new Graphraum(this.container, {
			maxPixelRatio: 1,
			mode,
			theme,
			visuals: createPlaygroundVisuals(appearance),
		});
		const data = createPlaygroundFixture(size);
		graph.setData(data);
		if (settings.get("overlay") === "on") this.overlay = graph.createOverlay(createPlaygroundOverlayOptions(onInspect));
		this.current = { graph, kind: "stress", size };

		this.layout = resolveStressLayout(formValue(settings, "layout") as StressLayoutChoice, size);
		if (this.layout !== "grid") {
			const force = readPlaygroundForceControls(settings, size);
			const isForce = this.layout === "force" || this.layout === "force-live";
			const edges = isForce ? packEdges(data.edges) : undefined;
			const clusters = isForce ? playgroundClusters(size) : undefined;
			this.onLayoutProgress(`Computing ${this.layout} layout`);
			this.layoutWorker().postMessage(
				{
					batchSize: force.batchSize,
					clusters,
					dimensions: mode === "2d" ? 2 : 3,
					edges,
					iterations: force.iterations,
					layout: this.layout,
					maxFps: 30,
					nodeCount: size,
					run: this.layoutRun,
					settings: force.settings,
					type: "start",
				},
				edges && clusters ? [edges.buffer, clusters.buffer] : [],
			);
		}
		return this.current;
	}

	/** Hands the container to Prove, which builds its own graph. */
	adoptProveGraph(graph: Graphraum) {
		this.current = { graph, kind: "prove" };
	}

	focus(nodeId: string | null) {
		if (this.current?.kind === "demo") focusNode(this.current.graph, this.current.useCase.data, nodeId);
		else this.current?.graph.setSelection(nodeId ? [nodeId] : []);
	}

	clear() {
		this.layoutRun += 1;
		this.liveFittedRun = -1;
		this.overlay?.destroy();
		this.overlay = null;
		this.current?.graph.destroy();
		this.current = null;
	}

	destroy() {
		this.clear();
		this.worker?.terminate();
		this.worker = null;
	}

	private layoutWorker() {
		if (this.worker) return this.worker;
		const worker = new Worker(new URL("../lib/layout-worker.ts", import.meta.url), { type: "module" });
		worker.addEventListener("message", ({ data }: MessageEvent<LayoutWorkerMessage>) => this.onWorkerMessage(data));
		this.worker = worker;
		return worker;
	}

	private onWorkerMessage(data: LayoutWorkerMessage) {
		const scene = this.current;
		if (data.run !== this.layoutRun || scene?.kind !== "stress") return;
		if (data.type === "complete") {
			scene.graph.fitView();
			this.onLayoutProgress("");
			return;
		}
		const start = data.end - data.positions.length / 3;
		const nodeIds = Array.from({ length: data.positions.length / 3 }, (_, index) => `node-${start + index}`);
		scene.graph.applyLayout({ nodeIds, positions: data.positions });
		if (this.layout === "force-live" && this.liveFittedRun !== data.run) {
			this.liveFittedRun = data.run;
			scene.graph.fitView();
		}
		this.onLayoutProgress(
			`${this.layout} layout · ${data.end.toLocaleString()} / ${scene.size.toLocaleString()} nodes`,
		);
		if (this.layout !== "force-live") {
			requestAnimationFrame(() => {
				if (data.run === this.layoutRun) this.worker?.postMessage({ run: data.run, type: "next" });
			});
		}
	}
}
