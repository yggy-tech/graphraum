// Cluster LOD on a seeded graph of coloured blobs, opened straight into the cluster view. Open with `bun run dev:lod`.
// Query: `?n=5000000` node count (default 200000), `?mode=3d`, `?animate=0` to swap without animation, `?worker=0` to build on the main thread.
// The graph lives in typed arrays only; a worker builds the tree and graphraum never receives more than the cut.
// Zoom in with the wheel or click a glyph; zoom out to watch regions merge. Use your system's
// reduced-motion setting to see the instant swap.
import { Graphraum } from "../../src";
import { nodeColorKeys, type OpenedClusterLod, openClusterLod } from "../../src/lod";

const params = new URLSearchParams(location.search);
const count = Math.max(1_000, Number(params.get("n") ?? 200_000));
const mode = params.get("mode") === "3d" ? "3d" : "2d";
const dimensions = mode === "3d" ? 3 : 2;
const status = document.getElementById("status") as HTMLElement;
const container = document.getElementById("graph") as HTMLElement;

const PALETTE = ["#8b7bff", "#3fd0b8", "#ffb347", "#ff6f91", "#5fb4ff", "#c4e05a"];
const PALETTE_KEYS = nodeColorKeys(PALETTE.map((color) => ({ color })));
let seed = 7;
const random = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const gaussian = () => Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random());

/** The graph as typed arrays: no object per node or edge, so millions fit. */
function createArrays() {
	const blobs = Math.max(8, Math.round(Math.sqrt(count) / 8));
	const centers = Array.from({ length: blobs }, () => ({
		color: Math.floor(random() * PALETTE_KEYS.length),
		x: (random() - 0.5) * 6000,
		y: (random() - 0.5) * 6000,
		z: (random() - 0.5) * (mode === "3d" ? 6000 : 0),
	}));
	const positions = new Float32Array(count * dimensions);
	const colors = new Uint32Array(count);
	for (let node = 0; node < count; node += 1) {
		const blob = centers[Math.floor(random() * blobs)] ?? (centers[0] as (typeof centers)[number]);
		// 85 percent of a blob share its colour, the rest take another one, so glyphs blend two or three colours.
		const colorIndex = random() < 0.85 ? blob.color : Math.floor(random() * PALETTE_KEYS.length);
		colors[node] = PALETTE_KEYS[colorIndex] as number;
		positions[node * dimensions] = blob.x + gaussian() * 260;
		positions[node * dimensions + 1] = blob.y + gaussian() * 260;
		if (dimensions === 3) positions[node * 3 + 2] = blob.z + gaussian() * 260;
	}
	const edges = new Uint32Array(count * 4);
	for (let edge = 0; edge < count * 2; edge += 1) {
		edges[edge * 2] = edge % count;
		edges[edge * 2 + 1] = Math.min(count - 1, Math.max(0, (edge % count) + Math.floor(gaussian() * 40)));
	}
	return { colors, dimensions, edges, positions } as const;
}

const heapMegabytes = () => {
	const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
	return memory ? `, heap ${Math.round(memory.usedJSHeapSize / 1_048_576)} MB` : "";
};

const input = createArrays();
const graph = new Graphraum(container, { mode, theme: { background: "#0b0d14" } });
const startedAt = performance.now();
let opened: OpenedClusterLod | null = null;
const lod = await openClusterLod(graph, input, {
	createWorker: () => new Worker(new URL("../../src/lod-worker.ts", import.meta.url), { type: "module" }),
	element: container,
	onCut: (d) => {
		const timings = opened?.getTimings();
		const edges =
			timings?.completeMilliseconds == null ? "building" : `in ${Math.round(timings.completeMilliseconds)} ms`;
		status.textContent = `${count.toLocaleString("en-US")} nodes, ${opened?.usedWorker === false ? "main thread" : "worker"}, first view ${Math.round(performance.now() - startedAt)} ms, edges ${edges}${heapMegabytes()}\n${d.drawnAggregates} glyphs, ${d.drawnNodes} nodes, ${d.drawnEdges} edges, depth ${d.cutDepth}, cut ${d.cutMilliseconds.toFixed(1)} ms`;
	},
	transitionMilliseconds: params.get("animate") === "0" ? 0 : 200,
	worker: params.get("worker") !== "0",
});
opened = lod;
Object.assign(window, { graph, lod });
