import type { WebGLRenderer } from "three";

import { Graphraum } from "../graphraum";
import type { GraphraumData, GraphraumOptions } from "../types";

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 300;

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

interface GraphraumInternals {
	renderFrame(): void;
	renderer: WebGLRenderer;
}

const mounted: { graph: Graphraum; container: HTMLElement }[] = [];

/** Mounts a graph in a fixed-size container at pixel ratio 1, so pixel coordinates are CSS pixels. */
export function mountGraph(options: GraphraumOptions = {}, data?: GraphraumData) {
	const container = document.createElement("div");
	container.style.cssText = `position:fixed;left:0;top:0;width:${CANVAS_WIDTH}px;height:${CANVAS_HEIGHT}px`;
	document.body.append(container);
	const graph = new Graphraum(container, { maxPixelRatio: 1, ...options });
	mounted.push({ container, graph });
	if (data) graph.setData(data);
	return graph;
}

export function unmountGraphs() {
	for (const { container, graph } of mounted.splice(0)) {
		graph.destroy();
		container.remove();
	}
}

function internals(graph: Graphraum) {
	return graph as unknown as GraphraumInternals;
}

/**
 * Renders one frame now and reads it back before the browser can clear the drawing buffer.
 * Throws when WebGL reports an error, so a failed draw cannot pass as an empty picture.
 */
export function renderAndRead(graph: Graphraum) {
	const { renderer } = internals(graph);
	internals(graph).renderFrame();
	const gl = renderer.getContext();
	const width = gl.drawingBufferWidth;
	const height = gl.drawingBufferHeight;
	const pixels = new Uint8Array(width * height * 4);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	const error = gl.getError();
	if (error !== gl.NO_ERROR) throw new Error(`WebGL error 0x${error.toString(16)} after rendering a frame.`);
	return {
		/** Pixel at CSS coordinates from the top-left corner. */
		at(x: number, y: number): Rgb {
			const row = height - 1 - Math.round(y);
			const index = (row * width + Math.round(x)) * 4;
			return { r: pixels[index] ?? 0, g: pixels[index + 1] ?? 0, b: pixels[index + 2] ?? 0 };
		},
		height,
		width,
	};
}

/** Every shader program three.js linked for this renderer, with its compile diagnostics. */
export function shaderPrograms(graph: Graphraum) {
	// three.js sets `diagnostics` while `renderer.debug.checkShaderErrors` is on (the default) but does not type it.
	const programs = (internals(graph).renderer.info.programs ?? []) as unknown as readonly {
		diagnostics?: { runnable: boolean };
		name: string;
	}[];
	return programs.map(({ diagnostics, name }) => ({ diagnostics, name }));
}

export function hexToRgb(hex: string): Rgb {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** Largest per-channel difference; small tolerances absorb antialiasing and sRGB rounding. */
export function colorDistance(a: Rgb, b: Rgb) {
	return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}
