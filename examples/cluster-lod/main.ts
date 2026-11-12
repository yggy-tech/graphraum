// Cluster LOD on a seeded graph of coloured blobs. Open with `bun run dev:lod`.
// Query: `?n=300000` node count (default 200000), `?mode=3d`, `?animate=0` to swap without animation.
// Zoom in with the wheel or click a glyph; zoom out to watch regions merge. Use your system's
// reduced-motion setting to see the instant swap.
import { Graphraum, type GraphraumData } from "../../src";
import { attachClusterLod, buildClusterTree, nodeColorKeys } from "../../src/lod";

const params = new URLSearchParams(location.search);
const count = Math.max(1_000, Number(params.get("n") ?? 200_000));
const mode = params.get("mode") === "3d" ? "3d" : "2d";
const dimensions = mode === "3d" ? 3 : 2;
const status = document.getElementById("status") as HTMLElement;
const container = document.getElementById("graph") as HTMLElement;

const PALETTE = ["#8b7bff", "#3fd0b8", "#ffb347", "#ff6f91", "#5fb4ff", "#c4e05a"];
let seed = 7;
const random = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const gaussian = () => Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random());

function createData(): GraphraumData {
	const blobs = Math.max(8, Math.round(Math.sqrt(count) / 8));
	const centers = Array.from({ length: blobs }, () => ({
		color: PALETTE[Math.floor(random() * PALETTE.length)],
		x: (random() - 0.5) * 6000,
		y: (random() - 0.5) * 6000,
		z: (random() - 0.5) * (mode === "3d" ? 6000 : 0),
	}));
	const nodes = Array.from({ length: count }, (_, index) => {
		const blob = centers[Math.floor(random() * blobs)] ?? centers[0];
		// 85 percent of a blob share its colour, the rest take another one, so glyphs blend two or three colours.
		const color = random() < 0.85 ? blob?.color : PALETTE[Math.floor(random() * PALETTE.length)];
		return {
			color,
			id: `n${index}`,
			position: {
				x: (blob?.x ?? 0) + gaussian() * 260,
				y: (blob?.y ?? 0) + gaussian() * 260,
				z: (blob?.z ?? 0) + (mode === "3d" ? gaussian() * 260 : 0),
			},
			size: 3,
		};
	});
	const edges = Array.from({ length: count * 2 }, (_, index) => ({
		id: `e${index}`,
		source: `n${index % count}`,
		target: `n${Math.min(count - 1, Math.max(0, (index % count) + Math.floor(gaussian() * 40)))}`,
	}));
	return { edges, nodes };
}

const data = createData();
const started = performance.now();
const tree = buildClusterTree({
	colors: nodeColorKeys(data.nodes),
	dimensions,
	edges: Uint32Array.from(data.edges.flatMap((edge) => [Number(edge.source.slice(1)), Number(edge.target.slice(1))])),
	positions: Float32Array.from(
		data.nodes.flatMap((node) => [node.position.x, node.position.y, node.position.z ?? 0].slice(0, dimensions)),
	),
});
const treeMs = Math.round(performance.now() - started);

const graph = new Graphraum(container, { mode, theme: { background: "#0b0d14" } });
const lod = attachClusterLod(graph, tree, {
	data,
	element: container,
	onCut: (d) => {
		status.textContent = `${count.toLocaleString("en-US")} nodes, tree ${treeMs} ms (main thread; use a worker)\n${d.drawnAggregates} glyphs, ${d.drawnNodes} nodes, ${d.drawnEdges} edges, depth ${d.cutDepth}, cut ${d.cutMilliseconds.toFixed(1)} ms`;
	},
	transitionMilliseconds: params.get("animate") === "0" ? 0 : 200,
});
Object.assign(window, { graph, lod });
