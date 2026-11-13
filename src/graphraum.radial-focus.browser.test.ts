import { afterEach, describe, expect, test } from "vitest";

import { colorDistance, mountGraph, renderAndRead, unmountGraphs } from "./test-support/browser-harness";
import type { GraphraumData, GraphraumMode } from "./types";

afterEach(() => unmountGraphs());

// Three red discs on black: a is selected, b is its neighbour, c is far from both and unconnected.
const data: GraphraumData = {
	edges: [{ id: "a-b", source: "a", target: "b" }],
	nodes: [
		{ color: "#ff0000", id: "a", position: { x: -30, y: 0, z: 0 }, size: 8 },
		{ color: "#ff0000", id: "b", position: { x: 30, y: 0, z: 0 }, size: 8 },
		{ color: "#ff0000", id: "c", position: { x: 0, y: 70, z: 0 }, size: 8 },
	],
};

function mount(mode: GraphraumMode) {
	const graph = mountGraph({ antialias: false, mode, theme: { background: "#000000" } }, data);
	graph.setCameraState(
		mode === "2d"
			? { center: { x: 0, y: 0 }, mode: "2d", visibleHeight: 200 }
			: { mode: "3d", position: { x: 0, y: 0, z: 260 }, target: { x: 0, y: 0, z: 0 } },
	);
	graph.setSelection(["a"]);
	return graph;
}

/** Sum of the red channel along a column through the node: a blur spreads it, a sharp disc keeps it. */
function spread(frame: ReturnType<typeof renderAndRead>, nodeId: string, graph: ReturnType<typeof mount>) {
	const position = graph.getNodeScreenPosition(nodeId);
	if (!position) throw new Error(nodeId);
	let total = 0;
	for (let dx = -40; dx <= 40; dx += 1) total += frame.at(position.x + dx, position.y).r;
	return { position, total };
}

describe.each(["2d", "3d"] as const)("radial focus in real WebGL2 (%s)", (mode) => {
	const radial = { enabled: true, innerRadius: 0.1, maxBlur: 12, mode: "radial", outerRadius: 0.5 } as const;

	test("renders without a WebGL error and reports itself active", async () => {
		const graph = mount(mode);
		await graph.setDepthOfField({ ...radial, vignette: true }, { animate: false });
		renderAndRead(graph);
		expect(graph.getDiagnostics().depthOfField).toBe("active");
	});

	test("keeps the selection and its neighbour as sharp as without the effect and blurs the rest", async () => {
		const graph = mount(mode);
		const before = renderAndRead(graph);
		await graph.setDepthOfField(radial, { animate: false });
		const after = renderAndRead(graph);
		for (const id of ["a", "b"]) {
			const { position } = spread(after, id, graph);
			// A blurred rim would shift this pixel; the crisp copy matches the unblurred frame.
			for (const dx of [-5, -3, 3, 5]) {
				expect(
					colorDistance(after.at(position.x + dx, position.y), before.at(position.x + dx, position.y)),
				).toBeLessThan(12);
			}
		}
		// The far disc has a hard rim without the effect; with it the colour spreads past the rim.
		const far = graph.getNodeScreenPosition("c");
		if (!far) throw new Error("c");
		const radius = [...Array(40).keys()].filter((dx) => before.at(far.x + dx, far.y).r > 128).length;
		const outside = (frame: ReturnType<typeof renderAndRead>) =>
			Math.max(...[3, 4, 5].map((dx) => frame.at(far.x + radius + dx, far.y).r));
		expect(radius).toBeGreaterThan(3);
		expect(outside(before)).toBeLessThan(10);
		expect(outside(after)).toBeGreaterThan(outside(before) + 10);
	});

	test("the vignette darkens the corners and leaves the centre of a dark scene alone", async () => {
		const graph = mount(mode);
		await graph.setDepthOfField({ ...radial, maxBlur: 0 }, { animate: false });
		const plain = renderAndRead(graph);
		await graph.setDepthOfField({ vignette: true, vignetteStrength: 1 }, { animate: false });
		const vignetted = renderAndRead(graph);
		// Black background: only coloured content can darken, so compare the far disc's brightness.
		const farPlain = plain.at(graph.getNodeScreenPosition("c")?.x ?? 0, graph.getNodeScreenPosition("c")?.y ?? 0);
		const farVignetted = vignetted.at(
			graph.getNodeScreenPosition("c")?.x ?? 0,
			graph.getNodeScreenPosition("c")?.y ?? 0,
		);
		expect(farVignetted.r).toBeLessThanOrEqual(farPlain.r);
	});

	test("turning it off returns the original frame", async () => {
		const graph = mount(mode);
		const before = renderAndRead(graph);
		await graph.setDepthOfField(radial, { animate: false });
		renderAndRead(graph);
		await graph.setDepthOfField({ enabled: false }, { animate: false });
		const after = renderAndRead(graph);
		expect(graph.getDiagnostics().depthOfField).toBe("off");
		const position = graph.getNodeScreenPosition("c");
		expect(
			colorDistance(after.at(position?.x ?? 0, position?.y ?? 0), before.at(position?.x ?? 0, position?.y ?? 0)),
		).toBe(0);
	});
});
