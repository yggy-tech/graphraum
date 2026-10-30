// Scenes for the README images. Open with `bun run dev:showcase` and `?scene=<id>`, then capture the
// viewport at 1600 x 900 (hero 1600 x 640). Everything is seeded, so every run draws the same graph.
import {
	computeForcePositions,
	Graphraum,
	type GraphraumData,
	type GraphraumEdge,
	type GraphraumNode,
	type GraphraumNodeShape,
} from "../../src";

type SceneId = "hero" | "labels" | "focus" | "scale";

const PALETTE = ["#8b7bff", "#3fd0b8", "#ffb347", "#ff6f91", "#5fb4ff", "#c4e05a", "#f78c4b", "#b07cf0"];
const SHAPES: GraphraumNodeShape[] = ["circle", "circle", "circle", "diamond", "hexagon", "square", "triangle"];

const params = new URLSearchParams(location.search);
const tuned = (name: string, fallback: number) => Number(params.get(name) ?? fallback);

function seeded(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 4_294_967_296;
	};
}

interface ClusteredGraph {
	clusters: Uint32Array;
	degree: Uint32Array;
	edgePairs: Uint32Array;
	nodeCount: number;
}

/** Clusters with a few hubs each, dense inside and sparse between, like real knowledge graphs. */
function clusteredGraph(nodeCount: number, clusterCount: number, seed: number): ClusteredGraph {
	const random = seeded(seed);
	const clusters = new Uint32Array(nodeCount);
	for (let index = 0; index < nodeCount; index += 1) clusters[index] = index % clusterCount;
	const members: number[][] = Array.from({ length: clusterCount }, () => []);
	for (let index = 0; index < nodeCount; index += 1) members[clusters[index] ?? 0]?.push(index);
	const pairs: number[] = [];
	for (let index = clusterCount; index < nodeCount; index += 1) {
		const group = members[clusters[index] ?? 0] ?? [];
		// Preferential attachment inside the cluster: early members become hubs.
		const target =
			group[Math.floor(random() ** tuned("hubby", 1) * Math.max(1, group.indexOf(index)))] ?? group[0] ?? 0;
		if (target !== index) pairs.push(index, target);
		if (random() < 0.035) pairs.push(index, Math.floor(random() * nodeCount));
	}
	for (let a = 0; a < clusterCount; a += 1)
		pairs.push(a, (a + 1 + Math.floor(random() * (clusterCount - 1))) % clusterCount);
	const degree = new Uint32Array(nodeCount);
	for (const node of pairs) degree[node] = (degree[node] ?? 0) + 1;
	return { clusters, degree, edgePairs: new Uint32Array(pairs), nodeCount };
}

function toData(graph: ClusteredGraph, positions: Float32Array, options: { glowHubs: boolean; edgeOpacity: number }) {
	const nodes: GraphraumNode[] = [];
	// The best-connected one percent glow.
	const hubDegree = [...graph.degree].sort((a, b) => b - a)[Math.floor(graph.nodeCount / 100)] ?? 1;
	for (let index = 0; index < graph.nodeCount; index += 1) {
		const degree = graph.degree[index] ?? 0;
		nodes.push({
			id: `n${index}`,
			position: { x: positions[index * 3] ?? 0, y: positions[index * 3 + 1] ?? 0, z: positions[index * 3 + 2] ?? 0 },
			color: PALETTE[(graph.clusters[index] ?? 0) % PALETTE.length],
			glow: options.glowHubs && degree >= hubDegree ? 0.9 : 0,
			shape: SHAPES[index % SHAPES.length],
			size: Math.min(14, 2.2 + Math.sqrt(degree) * 1.1),
		});
	}
	const edges: GraphraumEdge[] = [];
	for (let pair = 0; pair < graph.edgePairs.length; pair += 2) {
		const source = graph.edgePairs[pair] ?? 0;
		const target = graph.edgePairs[pair + 1] ?? 0;
		edges.push({
			id: `e${pair / 2}`,
			source: `n${source}`,
			target: `n${target}`,
			color: PALETTE[(graph.clusters[source] ?? 0) % PALETTE.length],
			opacity: options.edgeOpacity,
		});
	}
	return { edges, nodes } satisfies GraphraumData;
}

function forceLayout(graph: ClusteredGraph, dimensions: 2 | 3) {
	return computeForcePositions({
		clusters: graph.clusters,
		dimensions,
		edges: graph.edgePairs,
		iterations: tuned("iter", 400),
		nodeCount: graph.nodeCount,
		settings: {
			centerAttraction: tuned("center", 0.001),
			clusterStrength: tuned("cluster", 0.0015),
			damping: 0.82,
			linkDistance: tuned("link", 22),
			repulsion: tuned("repulsion", 3_500),
			springStrength: tuned("spring", 0.02),
		},
	});
}

const container = document.querySelector<HTMLElement>("#graph");
if (!container) throw new Error("missing #graph");
const scene = (new URLSearchParams(location.search).get("scene") ?? "hero") as SceneId;
const dark = { background: "#07080d", edgeOpacity: 0.35, edgeWidth: 0.9 } as const;

if (scene === "hero" || scene === "focus") {
	const graph = clusteredGraph(tuned("nodes", scene === "hero" ? 2_000 : 1_200), 8, 7);
	const positions = forceLayout(graph, 3);
	// Wide banner: spread the scene sideways so it fills a 5:2 frame.
	const stretch = tuned("stretch", scene === "hero" ? 2.2 : 1);
	for (let index = 0; index < positions.length; index += 3) positions[index] = (positions[index] ?? 0) * stretch;
	const data = toData(graph, positions, { edgeOpacity: tuned("edges", 0.45), glowHubs: true });
	const view = new Graphraum(container, {
		antialias: true,
		depthOfField:
			scene === "focus" ? { enabled: true, maxBlur: 24, strength: 0.9, transition: { durationMs: 0 } } : undefined,
		mode: params.get("mode") === "2d" ? "2d" : "3d",
		theme: dark,
	});
	view.setData(data);
	if (scene === "focus") view.setSelection(["n3"]);
} else if (scene === "labels") {
	const names = [
		"Ada Lovelace",
		"Analytical Engine",
		"Charles Babbage",
		"Mathematics",
		"London",
		"Notes G",
		"Difference Engine",
		"Royal Society",
		"Mary Somerville",
		"Bernoulli numbers",
		"Jacquard loom",
		"Poetry",
	];
	const shapes: GraphraumNodeShape[] = [
		"circle",
		"hexagon",
		"circle",
		"diamond",
		"square",
		"rounded",
		"hexagon",
		"square",
		"circle",
		"diamond",
		"pill",
		"triangle",
	];
	const links: [number, number][] = [
		[0, 1],
		[0, 2],
		[0, 3],
		[0, 4],
		[0, 5],
		[2, 1],
		[2, 6],
		[2, 7],
		[8, 0],
		[8, 3],
		[5, 9],
		[1, 10],
		[0, 11],
		[7, 4],
		[9, 3],
		[6, 3],
	];
	const random = seeded(3);
	const extra = tuned("extra", 28);
	const nodeCount = names.length + extra;
	const pairs: number[] = links.flat();
	for (let index = names.length; index < nodeCount; index += 1)
		pairs.push(index, Math.floor(random() ** 1.6 * names.length));
	const positions = computeForcePositions({
		dimensions: 2,
		edges: new Uint32Array(pairs),
		iterations: tuned("iter", 600),
		nodeCount,
		settings: {
			centerAttraction: 0.002,
			damping: 0.82,
			linkDistance: tuned("link", 70),
			repulsion: tuned("repulsion", 4_000),
			springStrength: tuned("spring", 0.01),
		},
	});
	const nodes: GraphraumNode[] = Array.from({ length: nodeCount }, (_, index) => ({
		id: names[index] ?? `fact ${index}`,
		position: { x: positions[index * 3] ?? 0, y: positions[index * 3 + 1] ?? 0 },
		color: PALETTE[index < names.length ? index % 5 : 4] ?? "#5fb4ff",
		shape: shapes[index] ?? "circle",
		size: index < names.length ? 9 : 3,
		strokeColor: "#ffffff",
		strokeWidth: index < names.length ? 1.2 : 0,
	}));
	const edges: GraphraumEdge[] = [];
	for (let pair = 0; pair < pairs.length; pair += 2) {
		const named = pair / 2 < links.length;
		edges.push({
			id: `e${pair}`,
			source: nodes[pairs[pair] ?? 0]?.id ?? "",
			target: nodes[pairs[pair + 1] ?? 0]?.id ?? "",
			marker: named ? "triangle" : "none",
			path: named ? "quadratic" : "straight",
			style: "solid",
			opacity: named ? 0.85 : 0.3,
			width: named ? 2 : 1,
		});
	}
	const view = new Graphraum(container, {
		antialias: true,
		mode: "2d",
		theme: { background: "#f6f4ef", edge: "#5a5d6b", edgeOpacity: 0.7, node: "#5fb4ff" },
	});
	view.setData({ edges, nodes });
	view
		.createOverlay({
			labelClassName: "label",
			labelPolicy: "manual",
			maxLabels: names.length,
			renderLabel: ({ id }) => Object.assign(document.createElement("span"), { textContent: id }),
		})
		.setLabels(names);
} else {
	// Layout is an input: a hand-rolled spiral galaxy, 100,000 nodes and 100,000 edges.
	const random = seeded(11);
	const nodeCount = 100_000;
	const arms = 5;
	const nodes: GraphraumNode[] = [];
	for (let index = 0; index < nodeCount; index += 1) {
		const arm = index % arms;
		// Radius grows with the index, so index neighbours are spatial neighbours and edges stay short.
		const radius = Math.sqrt((index + random() * arms * 40) / nodeCount) * 400;
		const angle = (arm / arms) * Math.PI * 2 + radius * 0.014 + (random() - 0.5) ** 3 * 2.4;
		const spread = 1 + random() * 18 * (1 - radius / 500);
		nodes.push({
			id: `n${index}`,
			position: {
				x: Math.cos(angle) * radius + (random() - 0.5) * spread,
				y: (random() - 0.5) * spread * 0.6,
				z: Math.sin(angle) * radius + (random() - 0.5) * spread,
			},
			color: PALETTE[radius < 60 ? 2 : arm % PALETTE.length],
			size: radius < 60 ? 1.1 : 0.7,
		});
	}
	const edges: GraphraumEdge[] = [];
	for (let index = arms; index < nodeCount; index += 1) {
		// Link each star to a near neighbour on its own arm, coloured like the arm.
		const target = Math.max(0, index - arms * (1 + Math.floor(random() * 4)));
		edges.push({ id: `e${index}`, source: `n${index}`, target: `n${target}`, color: nodes[index]?.color });
	}
	const view = new Graphraum(container, {
		maxVisibleEdges: 200_000,
		maxVisibleNodes: 100_000,
		mode: "3d",
		theme: { ...dark, edgeOpacity: 0.16, edgeWidth: 0.35 },
	});
	view.setData({ edges, nodes });
	view.setCameraState({ mode: "3d", position: { x: 0, y: 700, z: 760 }, target: { x: 0, y: 0, z: 0 } });
}
