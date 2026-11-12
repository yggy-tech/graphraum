import { OrthographicCamera } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import type { Graphraum } from "./graphraum";
import {
	createGraph,
	createShadowGpu,
	destroyGraphs,
	edgeBuffers,
	edgeInstancesByEdge,
	internals,
	mixedFixture,
	pickSubset,
	seededRandom,
	unusedVisibleSlots,
} from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumDiagnostics, GraphraumOptions, GraphraumTheme, GraphraumThemeName } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));
afterEach(() => {
	destroyGraphs();
	vi.restoreAllMocks();
});

type Operation = (graph: Graphraum) => void;

const COLORS = ["#ff0000", "#00ff00", "#123456", "#c47a1a", "#fcfffc"] as const;

function pick<T>(random: () => number, items: readonly T[]): T {
	const item = items[Math.floor(random() * items.length)];
	if (item === undefined) throw new Error("cannot pick from an empty list");
	return item;
}

/** Pans and zooms like the orbit controls do, then fires the same view-change handler. */
function viewAt(zoom: number, x: number, y: number): Operation {
	return (graph) => {
		const { camera } = internals(graph);
		if (camera instanceof OrthographicCamera) camera.zoom = zoom;
		camera.position.x = x;
		camera.position.y = y;
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld();
		internals(graph).handleViewChange();
	};
}

function themeChange(random: () => number): Partial<GraphraumTheme> | GraphraumThemeName {
	return pick<Partial<GraphraumTheme> | GraphraumThemeName>(random, [
		"light",
		"dark",
		{ dimmedEdge: pick(random, COLORS), dimmedEdgeOpacity: Math.round(random() * 100) / 100 },
		{ background: pick(random, [...COLORS, "transparent"]) },
		{ edge: pick(random, COLORS), edgeOpacity: 0.2 + random() * 0.8, edgeWidth: 1 + random() * 2 },
		{ selectedEdge: pick(random, COLORS) },
	]);
}

/**
 * Builds one random step. Parameters are drawn once so the same operation can be applied to the
 * graph under test and to the reference twin.
 */
function nextOperation(random: () => number, graph: Graphraum, state: { counter: number; knownIds: Set<string> }) {
	const { data } = internals(graph);
	const edgeIds = data.edges.map((edge) => edge.id);
	const nodeIds = data.nodes.map((node) => node.id);
	for (const id of edgeIds) state.knownIds.add(id);
	const idPool = [...state.knownIds, "ghost-a", "ghost-b"];
	const roll = random();
	if (roll < 0.22) {
		const ids = pickSubset(random, idPool, 0.08);
		return { kind: "state", apply: (target: Graphraum) => target.setEdgeSelection(ids) } as const;
	}
	if (roll < 0.4) {
		const ids = pickSubset(random, idPool, 0.4);
		return { kind: "state", apply: (target: Graphraum) => target.setEdgeState("dimmed", ids) } as const;
	}
	if (roll < 0.45) {
		const clearSelection = random() < 0.5;
		return {
			kind: "state",
			apply: (target: Graphraum) => (clearSelection ? target.setEdgeSelection([]) : target.setEdgeState("dimmed", [])),
		} as const;
	}
	if (roll < 0.55) {
		const theme = themeChange(random);
		return { kind: "theme", apply: (target: Graphraum) => target.setTheme(theme) } as const;
	}
	if (roll < 0.66) {
		const node = pick(random, data.nodes);
		const zoom = pick(random, [1, 2, 4, 8]);
		return { kind: "view", apply: viewAt(zoom, node.position.x + random() * 20, node.position.y) } as const;
	}
	if (roll < 0.74) {
		state.counter += 1;
		const id = `m${state.counter}`;
		const addedNodes = [{ id, position: { x: random() * 400 - 200, y: random() * 400 - 200 } }];
		const addedEdges = Array.from({ length: 3 }, (_, offset) => ({
			id: `x${state.counter}-${offset}`,
			source: pick(random, nodeIds),
			target: id,
			...(offset === 0 ? { marker: "triangle" as const, path: "cubic" as const } : {}),
		}));
		return {
			kind: "topology",
			apply: (target: Graphraum) => target.applyDataPatch({ addedEdges, addedNodes }),
		} as const;
	}
	if (roll < 0.82) {
		const removedEdgeIds = pickSubset(random, edgeIds, 0.03);
		const removedNodeIds = random() < 0.4 && nodeIds.length > 10 ? [pick(random, nodeIds)] : [];
		return {
			kind: "topology",
			apply: (target: Graphraum) => target.applyDataPatch({ removedEdgeIds, removedNodeIds }),
		} as const;
	}
	if (roll < 0.86) {
		const next = mixedFixture(30 + Math.floor(random() * 15), 80 + Math.floor(random() * 60), state.counter + 100);
		return { kind: "topology", apply: (target: Graphraum) => target.setData(next) } as const;
	}
	const node = pick(random, data.nodes);
	const position = { x: node.position.x + random() * 6 - 3, y: node.position.y + random() * 6 - 3, z: 0 };
	return { kind: "move", apply: (target: Graphraum) => target.updateNodes([{ id: node.id, position }]) } as const;
}

const stateCounts = (diagnostics: GraphraumDiagnostics) => ({
	dimmedEdges: diagnostics.dimmedEdges,
	lodLevel: diagnostics.lodLevel,
	selectedEdges: diagnostics.selectedEdges,
	visibleEdges: diagnostics.visibleEdges,
});

interface PropertyConfig {
	/** `per-edge` only where slot order legitimately differs; see the comment below. */
	compare: "bytes" | "per-edge";
	moves: boolean;
	name: string;
	options: GraphraumOptions;
	tier: GraphraumDiagnostics["lodLevel"];
}

/**
 * In 2D with viewport culling, `SpatialGrid2D.set` splices a moved node out of its cell and
 * pushes it to the end of its (possibly new) cell. The in-place endpoint patch keeps the old
 * slots, but a later materialize walks the grid in the new order and packs edges into different
 * slots. The two culled 2D configurations (detail and density) therefore compare instance data
 * per edge; every other configuration compares the raw buffers byte for byte.
 */
/** 300 seeded steps with a full twin rebuild each; a CI runner needs more than vitest's 5 s default. */
const PROPERTY_TEST_TIMEOUT_MS = 60_000;

const CONFIGS: readonly PropertyConfig[] = [
	{ compare: "per-edge", moves: true, name: "2d culled", options: { mode: "2d" }, tier: "detail" },
	{
		compare: "bytes",
		moves: true,
		name: "2d unculled",
		options: { mode: "2d", viewportCulling: false },
		tier: "detail",
	},
	{ compare: "bytes", moves: true, name: "3d", options: { mode: "3d" }, tier: "detail" },
	// Node moves reorder the budget candidates on main, which changes the budgeted subset itself.
	{
		compare: "per-edge",
		moves: false,
		name: "2d overview budget",
		options: { maxVisibleEdges: 48, mode: "2d" },
		tier: "overview",
	},
	{
		compare: "per-edge",
		moves: true,
		name: "2d density",
		options: { maxVisibleNodes: 16, mode: "2d" },
		tier: "density",
	},
];

describe("edge state equivalence under random interleavings", () => {
	test.each(CONFIGS)(
		"$name: incremental graph matches a fully materialized twin",
		(config) => {
			const random = seededRandom(config.name.length * 7919);
			const graph = createGraph(config.options);
			const twin = createGraph(config.options);
			const initial = mixedFixture(40, 120, 3);
			graph.setData(initial);
			twin.setData(initial);
			const materialize = vi.spyOn(internals(graph), "materializeViewport");
			const gpu = createShadowGpu();
			const snapshot = config.compare === "bytes" ? edgeBuffers : edgeInstancesByEdge;
			const state = { counter: 0, knownIds: new Set<string>() };
			const tiers = new Set<string>();
			const kinds = new Set<string>();

			for (let step = 0; step < 300; step += 1) {
				let operation = nextOperation(random, graph, state);
				while (!config.moves && operation.kind === "move") operation = nextOperation(random, graph, state);
				kinds.add(operation.kind);
				const before = materialize.mock.calls.length;
				operation.apply(graph);
				// Over the edge budget, selecting an edge the budget left out repacks to pin it.
				if (operation.kind === "state" && config.tier !== "overview") {
					expect(materialize.mock.calls.length, `step ${step}`).toBe(before);
				}
				operation.apply(twin);
				internals(twin).materializeViewport();

				expect(snapshot(graph), `step ${step} (${operation.kind})`).toEqual(snapshot(twin));
				expect(unusedVisibleSlots(graph), `step ${step} (${operation.kind})`).toBe(0);
				expect(stateCounts(graph.getDiagnostics())).toEqual(stateCounts(twin.getDiagnostics()));
				tiers.add(graph.getDiagnostics().lodLevel);
				if (random() < 0.5) {
					gpu.upload(graph);
					for (const { cpu, gpu: uploaded } of gpu.compare(graph)) expect(uploaded, `GPU step ${step}`).toEqual(cpu);
				}
			}

			expect(tiers).toContain(config.tier);
			expect([...kinds].sort()).toEqual(
				config.moves ? ["move", "state", "theme", "topology", "view"] : ["state", "theme", "topology", "view"],
			);
		},
		PROPERTY_TEST_TIMEOUT_MS,
	);

	test("edges selected or dimmed while culled show their state once panned into view", () => {
		const graph = createGraph({ mode: "2d" });
		const twin = createGraph({ mode: "2d" });
		const data = mixedFixture(40, 120, 3);
		graph.setData(data);
		twin.setData(data);
		const near = data.nodes.reduce((best, node) => (node.position.x < best.position.x ? node : best));
		const far = data.nodes.reduce((best, node) => (node.position.x > best.position.x ? node : best));
		for (const target of [graph, twin]) viewAt(8, near.position.x, near.position.y)(target);

		const visible = internals(graph).visibleEdgeLayouts;
		const culledFarEdges = data.edges.flatMap((edge, index) =>
			(edge.source === far.id || edge.target === far.id) && !visible.has(index) ? [{ id: edge.id, index }] : [],
		);
		expect(culledFarEdges.length).toBeGreaterThan(1);
		const ids = culledFarEdges.map(({ id }) => id);
		const selected = ids.slice(0, 1);

		graph.setEdgeSelection(selected);
		graph.setEdgeState("dimmed", ids);
		for (const target of [graph, twin]) viewAt(8, far.position.x, far.position.y)(target);
		twin.setEdgeSelection(selected);
		twin.setEdgeState("dimmed", ids);
		internals(twin).materializeViewport();

		for (const { index } of culledFarEdges) expect(internals(graph).visibleEdgeLayouts.has(index)).toBe(true);
		expect(edgeBuffers(graph)).toEqual(edgeBuffers(twin));
		expect(edgeBuffers(graph)).not.toEqual(edgeBuffers(createUnstyledTwin(data, far.position)));
	});
});

function createUnstyledTwin(data: ReturnType<typeof mixedFixture>, at: { x: number; y: number }) {
	const plain = createGraph({ mode: "2d" });
	plain.setData(data);
	viewAt(8, at.x, at.y)(plain);
	return plain;
}
