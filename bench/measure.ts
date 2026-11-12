import type { Graphraum } from "../src";
import type { BenchEnvironment } from "./types";

export const MAX_PIXEL_RATIO = 1;

export function nextFrame() {
	return new Promise<number>((resolve) => requestAnimationFrame(resolve));
}

export interface FrameSamples extends Record<string, (number | null)[]> {
	cpuMs: number[];
	frameMs: number[];
	gpuMs: (number | null)[];
	/** Time the driving call itself took on the main thread (camera move, selection change). */
	stepMs: number[];
	/** `stepMs + cpuMs`: the main-thread cost of one frame. */
	totalMs: number[];
}

/**
 * Drives `count` frames. `step` runs before each frame (null for loops that animate themselves, like
 * auto-orbit); every frame then reads the renderer's own CPU time and the GPU time when the browser
 * has a timer. GPU time lags a frame or two behind, which is fine for pooled statistics.
 */
export async function sampleFrames(
	graph: Graphraum,
	count: number,
	step: ((index: number) => void) | null,
): Promise<FrameSamples> {
	const samples: FrameSamples = { cpuMs: [], frameMs: [], gpuMs: [], stepMs: [], totalMs: [] };
	let previous = await nextFrame();
	for (let index = 0; index < count; index += 1) {
		const startedAt = performance.now();
		step?.(index);
		if (step) graph.render();
		const stepMs = performance.now() - startedAt;
		const current = await nextFrame();
		const frameEnd = performance.now();
		const diagnostics = graph.getDiagnostics();
		samples.stepMs.push(stepMs);
		samples.cpuMs.push(diagnostics.cpuFrameMilliseconds);
		samples.gpuMs.push(diagnostics.gpuFrameMilliseconds);
		samples.totalMs.push(stepMs + diagnostics.cpuFrameMilliseconds);
		samples.frameMs.push(step ? frameEnd - startedAt : current - previous);
		previous = current;
		window.__benchProgress = `${index + 1}/${count} frames, frame ${samples.frameMs.at(-1)?.toFixed(1)} step ${samples.stepMs.at(-1)?.toFixed(1)} cpu ${samples.cpuMs.at(-1)?.toFixed(1)} gpu ${samples.gpuMs.at(-1)}`;
	}
	return samples;
}

export function readEnvironment(): BenchEnvironment {
	const canvas = document.createElement("canvas");
	const gl = canvas.getContext("webgl2");
	const debug = gl?.getExtension("WEBGL_debug_renderer_info");
	const glRenderer = String(
		debug && gl ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : (gl?.getParameter(gl.RENDERER) ?? "no WebGL2"),
	);
	const glVendor = String(
		debug && gl ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : (gl?.getParameter(gl.VENDOR) ?? "unknown"),
	);
	const gpuTimer = gl?.getExtension("EXT_disjoint_timer_query_webgl2") != null;
	gl?.getExtension("WEBGL_lose_context")?.loseContext();
	return {
		devicePixelRatio: window.devicePixelRatio,
		glRenderer,
		glVendor,
		gpuTimer,
		maxPixelRatio: MAX_PIXEL_RATIO,
		softwareRenderer: /swiftshader|llvmpipe|software|softpipe/i.test(glRenderer),
		userAgent: navigator.userAgent,
		viewport: { height: window.innerHeight, width: window.innerWidth },
	};
}
