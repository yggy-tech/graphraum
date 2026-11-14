// A graph that arrives in batches, the way a host streams a large graph in. Open with `bun run dev:stream`.
// "Nodes" appends every batch with `applyDataPatch(patch, { enter })`, so new nodes grow in where they land.
// "Groups" rebuilds the cluster tree every few batches and hands it to the cluster layer's `update`, so
// glyphs grow and glide instead of the picture being rebuilt. Query: `?n=60000` total nodes, `?mode=3d`.
// The sliders are written to the address, so a setting you like can be shared as a link.
import { Graphraum, type GraphraumEdge, type GraphraumNode } from "../../src";
import { attachClusterLod, buildClusterTree, type ClusterLodHandle, nodeColorKeys } from "../../src/lod";

const params = new URLSearchParams(location.search);
const total = Math.max(1_000, Number(params.get("n") ?? 60_000));
const mode = params.get("mode") === "3d" ? "3d" : "2d";
const dimensions = mode === "3d" ? 3 : 2;

const settings = {
	batch: Number(params.get("batch") ?? 300),
	enter: Number(params.get("enter") ?? 420),
	every: Number(params.get("every") ?? 120),
	follow: params.get("follow") !== "0",
	glide: Number(params.get("glide") ?? 600),
	regroup: Number(params.get("regroup") ?? 600),
	view: params.get("view") === "flat" ? "flat" : "cluster",
};
type Settings = typeof settings;

const PALETTE = ["#8b7bff", "#3fd0b8", "#ffb347", "#ff6f91", "#5fb4ff", "#c4e05a", "#e58cff", "#7fd1ff"];
let seed = 11;
const random = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const gaussian = () => Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random());

/**
 * The whole graph, in the order a stream finds it: outward from one seed group, with some mixing, and
 * every edge pointing back at a node that arrived earlier, so each batch is an append.
 */
function createGraph() {
	const groups = Math.max(12, Math.round(total / 150));
	const spread = Math.sqrt(groups) * 420;
	const centers = Array.from({ length: groups }, () => ({
		color: PALETTE[Math.floor(random() * PALETTE.length)] as string,
		x: (random() - 0.5) * spread,
		y: (random() - 0.5) * spread,
		z: mode === "3d" ? (random() - 0.5) * spread : 0,
	}));
	const origin = centers[0] as (typeof centers)[number];
	const far = Math.max(...centers.map((c) => Math.hypot(c.x - origin.x, c.y - origin.y, c.z - origin.z)), 1);
	const draft = Array.from({ length: total }, () => {
		const group = Math.floor(random() * groups);
		const center = centers[group] as (typeof centers)[number];
		const reach = Math.hypot(center.x - origin.x, center.y - origin.y, center.z - origin.z) / far;
		return { found: reach * 0.75 + random() * 0.25, group };
	}).sort((a, b) => a.found - b.found);

	const nodes: GraphraumNode[] = [];
	const edges: GraphraumEdge[] = [];
	const membersOf = Array.from({ length: groups }, () => [] as number[]);
	for (const [index, { group }] of draft.entries()) {
		const center = centers[group] as (typeof centers)[number];
		const color = random() < 0.88 ? center.color : (PALETTE[Math.floor(random() * PALETTE.length)] as string);
		nodes.push({
			color,
			id: `n${index}`,
			position: {
				x: center.x + gaussian() * 90,
				y: center.y + gaussian() * 90,
				z: mode === "3d" ? center.z + gaussian() * 90 : 0,
			},
			size: 3 + random() * 3,
		});
		const members = membersOf[group] as number[];
		const links = members.length === 0 ? 0 : random() < 0.4 ? 2 : 1;
		for (let link = 0; link < links; link += 1) {
			const other = members[Math.floor(random() * members.length)] as number;
			edges.push({ id: `e${edges.length}`, source: `n${other}`, target: `n${index}` });
		}
		if (index > 0 && random() < 0.04) {
			edges.push({ id: `e${edges.length}`, source: `n${Math.floor(random() * index)}`, target: `n${index}` });
		}
		members.push(index);
	}
	// Edge `i` arrives with its later endpoint, so a batch carries the edges of its own nodes.
	const lastEdgeOf = new Int32Array(total).fill(-1);
	for (const [index, edge] of edges.entries()) lastEdgeOf[Number(edge.target.slice(1))] = index;
	return { edges, lastEdgeOf, nodes };
}

const graphData = createGraph();
const colorKeys = nodeColorKeys(graphData.nodes);
const container = document.getElementById("graph") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const graph = new Graphraum(container, { mode, theme: { background: "#0b0d14" } });

let loadedNodes = 0;
let loadedEdges = 0;
let paused = false;
let streamTimer = 0;
let regroupTimer = 0;
let followTimer = 0;
let lod: ClusterLodHandle | null = null;
let groupedNodes = 0;
let startedAt = performance.now();

/** The nodes and edges of the next batch. */
function nextBatch() {
	const nodeEnd = Math.min(total, loadedNodes + settings.batch);
	let edgeEnd = loadedEdges;
	for (let node = nodeEnd - 1; node >= loadedNodes; node -= 1) {
		const last = graphData.lastEdgeOf[node] as number;
		if (last >= 0) {
			edgeEnd = Math.max(edgeEnd, last + 1);
			break;
		}
	}
	const batch = {
		addedEdges: graphData.edges.slice(loadedEdges, edgeEnd),
		addedNodes: graphData.nodes.slice(loadedNodes, nodeEnd),
	};
	loadedNodes = nodeEnd;
	loadedEdges = edgeEnd;
	return batch;
}

const loaded = () => ({ edges: graphData.edges.slice(0, loadedEdges), nodes: graphData.nodes.slice(0, loadedNodes) });

function treeOfLoaded() {
	const positions = new Float32Array(loadedNodes * dimensions);
	for (let index = 0; index < loadedNodes; index += 1) {
		const { position } = graphData.nodes[index] as GraphraumNode;
		positions[index * dimensions] = position.x;
		positions[index * dimensions + 1] = position.y;
		if (dimensions === 3) positions[index * 3 + 2] = position.z ?? 0;
	}
	const indexOf = (id: string) => Number(id.slice(1));
	const edges = new Uint32Array(loadedEdges * 2);
	for (let index = 0; index < loadedEdges; index += 1) {
		const edge = graphData.edges[index] as GraphraumEdge;
		edges[index * 2] = indexOf(edge.source);
		edges[index * 2 + 1] = indexOf(edge.target);
	}
	return buildClusterTree({ colors: colorKeys.subarray(0, loadedNodes), dimensions, edges, positions });
}

/** Cluster view: hand the layer a tree of everything loaded so far. */
function regroup() {
	if (loadedNodes === groupedNodes) return;
	const built = performance.now();
	const tree = treeOfLoaded();
	const buildMs = performance.now() - built;
	if (lod) {
		lod.update(tree, { data: loaded() });
	} else {
		lod = attachClusterLod(graph, tree, {
			data: loaded(),
			element: container,
			updateMilliseconds: settings.glide,
		});
	}
	groupedNodes = loadedNodes;
	report(`tree ${buildMs.toFixed(0)} ms`);
}

function streamStep() {
	if (paused) return;
	if (loadedNodes >= total) {
		if (settings.view === "cluster") regroup();
		report("done");
		return;
	}
	const first = loadedNodes === 0;
	const batch = nextBatch();
	if (settings.view === "flat") {
		if (first) {
			graph.setData({ edges: [...batch.addedEdges], nodes: [...batch.addedNodes] });
		} else {
			graph.applyDataPatch(batch, { enter: { durationMs: settings.enter, staggerMs: settings.every } });
		}
		report();
	} else if (first) {
		regroup();
	}
	streamTimer = window.setTimeout(streamStep, settings.every);
}

function report(extra = "") {
	const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
	const diagnostics = lod?.getDiagnostics();
	const drawn = diagnostics ? `\n${diagnostics.drawnAggregates} groups, ${diagnostics.drawnNodes} nodes drawn` : "";
	status.textContent = `${loadedNodes.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} nodes, ${seconds} s${drawn}${extra ? `\n${extra}` : ""}`;
}

function follow() {
	if (settings.follow && !paused) void graph.flyTo({ durationMs: 1100, distanceScale: 1.1 });
}

function restart() {
	window.clearTimeout(streamTimer);
	window.clearInterval(regroupTimer);
	window.clearInterval(followTimer);
	lod?.detach();
	lod = null;
	loadedNodes = 0;
	loadedEdges = 0;
	groupedNodes = 0;
	paused = false;
	startedAt = performance.now();
	graph.setData({ edges: [], nodes: [] });
	syncControls();
	streamStep();
	if (settings.view === "cluster") regroupTimer = window.setInterval(regroup, settings.regroup);
	followTimer = window.setInterval(follow, 1200);
}

// Controls.
const sliders = ["batch", "every", "enter", "glide", "regroup"] as const;
function writeAddress() {
	const next = new URLSearchParams(location.search);
	for (const key of sliders) next.set(key, String(settings[key]));
	next.set("view", settings.view);
	next.set("follow", settings.follow ? "1" : "0");
	history.replaceState(null, "", `?${next}`);
}
function syncControls() {
	for (const key of sliders) {
		(document.getElementById(key) as HTMLInputElement).value = String(settings[key]);
		(document.getElementById(`${key}-out`) as HTMLOutputElement).textContent = String(settings[key]);
	}
	(document.getElementById("follow") as HTMLInputElement).checked = settings.follow;
	document.getElementById("view-cluster")?.setAttribute("aria-pressed", String(settings.view === "cluster"));
	document.getElementById("view-flat")?.setAttribute("aria-pressed", String(settings.view === "flat"));
	(document.getElementById("pause") as HTMLButtonElement).textContent = paused ? "Resume" : "Pause";
}
for (const key of sliders) {
	document.getElementById(key)?.addEventListener("input", (event) => {
		settings[key] = Number((event.target as HTMLInputElement).value) as Settings[typeof key];
		syncControls();
		writeAddress();
		// The glide and regroup timing are read when the layer and its timer start.
		if (key === "glide" || (key === "regroup" && settings.view === "cluster")) restart();
	});
}
document.getElementById("follow")?.addEventListener("change", (event) => {
	settings.follow = (event.target as HTMLInputElement).checked;
	writeAddress();
});
for (const view of ["cluster", "flat"] as const) {
	document.getElementById(`view-${view}`)?.addEventListener("click", () => {
		settings.view = view;
		writeAddress();
		restart();
	});
}
document.getElementById("restart")?.addEventListener("click", restart);
document.getElementById("pause")?.addEventListener("click", () => {
	paused = !paused;
	syncControls();
	if (!paused) streamStep();
});
// Steering the camera stops it from following.
for (const type of ["pointerdown", "wheel"]) {
	container.addEventListener(type, () => {
		if (!settings.follow) return;
		settings.follow = false;
		syncControls();
		writeAddress();
	});
}

Object.assign(window, { graph });
restart();
