import type { GraphraumMode } from "../../../src/types";
import { expandUseCase } from "./scene-graph";
import { type DemoUseCase, type DemoUseCaseId, demoUseCases } from "./use-case-demos";

export type DemoSceneId = "fraud" | "knowledge" | "software";
export type PlaygroundSceneId = DemoSceneId | "stress";
export type StressSize = 1_000 | 10_000 | 100_000;

export interface PlaygroundScene {
	id: PlaygroundSceneId;
	label: string;
	title: string;
	description: string;
}

export interface PlaygroundState {
	mode: GraphraumMode;
	prove: boolean;
	scene: PlaygroundSceneId;
	size: StressSize;
}

export const stressSizes = [1_000, 10_000, 100_000] as const satisfies readonly StressSize[];

export const playgroundScenes = [
	{
		id: "knowledge",
		label: "Knowledge",
		title: "Knowledge graph",
		description: "People, places and ideas, with sources on every link.",
	},
	{
		id: "software",
		label: "Software",
		title: "Software topology",
		description: "Services, data stores and owners. See what breaks before it does.",
	},
	{
		id: "fraud",
		label: "Fraud",
		title: "Fraud investigation",
		description: "Accounts, devices and cards that share more than they should.",
	},
	{
		id: "stress",
		label: "Stress",
		title: "Stress test",
		description: "Up to 100,000 nodes and 300,000 edges, with live layouts.",
	},
] as const satisfies readonly PlaygroundScene[];

const useCaseByScene: Record<DemoSceneId, DemoUseCaseId> = {
	fraud: "investigation",
	knowledge: "knowledge",
	software: "dependencies",
};

const sceneSeeds: Record<DemoSceneId, number> = { fraud: 33, knowledge: 7, software: 21 };

/** Context nodes generated around each curated demo. */
export const SCENE_CONTEXT_NODES = 320;

export const defaultPlaygroundState: PlaygroundState = { mode: "2d", prove: false, scene: "knowledge", size: 10_000 };

function isSceneId(value: string | null): value is PlaygroundSceneId {
	return playgroundScenes.some(({ id }) => id === value);
}

function isStressSize(value: number): value is StressSize {
	return (stressSizes as readonly number[]).includes(value);
}

/** Reads the playground deep link. Prove always runs on the stress scene, at 100k unless a size is given. */
export function parsePlaygroundState(search: string): PlaygroundState {
	const params = new URLSearchParams(search);
	const prove = params.get("prove") === "1";
	const sceneParam = params.get("scene");
	const scene = prove ? "stress" : isSceneId(sceneParam) ? sceneParam : defaultPlaygroundState.scene;
	const sizeParam = Number(params.get("size"));
	const size = isStressSize(sizeParam) ? sizeParam : prove ? 100_000 : defaultPlaygroundState.size;
	const mode = params.get("mode") === "3d" ? "3d" : "2d";
	return { mode, prove, scene, size };
}

/** Writes only the values that differ from the defaults, so shared links stay short. */
export function serializePlaygroundState(state: PlaygroundState): string {
	const params = new URLSearchParams();
	if (state.scene !== defaultPlaygroundState.scene) params.set("scene", state.scene);
	if (state.scene === "stress" && state.size !== defaultPlaygroundState.size) params.set("size", String(state.size));
	if (state.mode !== defaultPlaygroundState.mode) params.set("mode", state.mode);
	if (state.prove) params.set("prove", "1");
	const query = params.toString();
	return query ? `?${query}` : "";
}

export function sceneById(id: PlaygroundSceneId): PlaygroundScene {
	const scene = playgroundScenes.find((candidate) => candidate.id === id);
	if (!scene) throw new Error(`Unknown playground scene "${id}"`);
	return scene;
}

/** The curated demo for a scene, grown with deterministic context entities. */
export function createSceneUseCase(id: DemoSceneId, contextNodes = SCENE_CONTEXT_NODES): DemoUseCase {
	const useCase = demoUseCases.find((candidate) => candidate.id === useCaseByScene[id]);
	if (!useCase) throw new Error(`Missing demo use case for scene "${id}"`);
	return expandUseCase(useCase, contextNodes, sceneSeeds[id]);
}

const quoted = (values: readonly string[]) => `[${values.map((value) => `"${value}"`).join(", ")}]`;

const demoCode = (
	contents: string,
	squares: readonly string[],
	diamonds: readonly string[],
) => `import { Graphraum, defineVisuals } from "@yggy-tech/graphraum";

const shapeFor = (category: string) =>
  ${quoted(squares)}.includes(category) ? "square"
  : ${quoted(diamonds)}.includes(category) ? "diamond"
  : "circle";

const visuals = defineVisuals<NodeAttributes, EdgeAttributes>({
  node: (node) => ({
    visual: {
      color: node.attributes.color,
      shape: shapeFor(node.attributes.category),
      size: node.attributes.size,
    },
    presentation: {
      title: node.attributes.label,
      subtitle: node.attributes.subtitle,
      actions: [{ id: "trace-connections", label: "Trace connections" }],
    },
  }),
  edge: (edge) => ({
    visual: { color: edge.attributes.color },
    presentation: { title: edge.attributes.relationship },
  }),
});

const graph = new Graphraum(container, { visuals });
graph.setData({ nodes, edges }); // ${contents}

container.addEventListener("click", (event) => {
  const id = graph.pick(event.clientX, event.clientY);
  graph.setSelection(id ? [id] : []);
  inspector.render(id ? graph.getNodePresentation(id) : null); // your UI
});`;

const sceneCodeById: Record<PlaygroundSceneId, string> = {
	fraud: demoCode("accounts, devices, payment methods, merchants", ["Payment method"], ["Device"]),
	knowledge: demoCode("people, places, concepts, sources", ["Place"], ["Concept", "Field"]),
	software: demoCode("applications, services, gateways, data stores", ["Service", "Database"], ["Gateway"]),
	stress: `import { Graphraum, createForceSimulation } from "@yggy-tech/graphraum";

const graph = new Graphraum(container, { mode: "2d", maxPixelRatio: 1 });
graph.setData({ nodes, edges }); // 100,000 nodes, 300,000 edges

// Positions stream in from a worker without blocking the first frame.
worker.onmessage = ({ data }) => {
  graph.applyLayout({ nodeIds: data.nodeIds, positions: data.positions });
};

const diagnostics = graph.getDiagnostics();
console.log(diagnostics.gpuDrawCalls); // 2`,
};

export function sceneCode(id: PlaygroundSceneId): string {
	return sceneCodeById[id];
}

export type StressLayoutChoice = "auto" | "circle" | "force" | "force-live" | "grid";
export type StressLayout = Exclude<StressLayoutChoice, "auto">;

/** `auto` runs force layout up to 10k nodes and keeps the grid at 100k, where force takes seconds. */
export function resolveStressLayout(choice: StressLayoutChoice, size: StressSize): StressLayout {
	if (choice !== "auto") return choice;
	return size >= 100_000 ? "grid" : "force";
}
