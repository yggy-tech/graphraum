/**
 * Worker entry of the parallel multilevel layout. It keeps one region simulation at a time: `init`
 * builds it, each `round` runs a few steps, and `publish` (shared memory only) writes the region's
 * positions where the other regions read them. Bundlers load this file through the
 * `new Worker(new URL(...))` call in `layout-multilevel.ts`; hosts can start it themselves with
 * `createWorker`.
 */

import { createRegionForceSimulation, type ForceSimulation } from "./force-layout";
import type { RegionReply, RegionRequest } from "./layout-multilevel-regions";

/** A region worker's state between messages. */
export interface RegionWorkerState {
	owned?: Uint32Array;
	shared?: Float32Array;
	simulation?: ForceSimulation;
}

/** Handles one message; returns the reply and the buffers to transfer with it. */
export function handleRegionMessage(
	state: RegionWorkerState,
	message: RegionRequest,
): { reply: RegionReply; transfer: Transferable[] } {
	try {
		if (message.type === "init") {
			state.owned = message.owned;
			state.shared = message.shared ? message.start : undefined;
			state.simulation = createRegionForceSimulation(
				{
					anchors: message.anchors,
					clusters: message.clusters,
					dimensions: message.dimensions,
					edges: message.edges,
					initialPositions: message.start,
					linkDistances: message.linkDistances,
					nodeCount: message.nodeCount,
					settings: message.settings,
					springStrengths: message.springStrengths,
					warmStart: true,
				},
				message.owned,
			);
			return { reply: { type: "ready" }, transfer: [] };
		}
		const { owned, shared, simulation } = state;
		if (!simulation || !owned) throw new Error("The region worker got a message before init.");
		if (message.type === "round") {
			if (message.sync === "snapshot" && message.snapshot) simulation.positions.set(message.snapshot);
			else if (message.sync === "shared" && shared) simulation.positions.set(shared);
			for (const alpha of message.alphas) simulation.step(alpha);
			if (shared) return { reply: { type: "rounded" }, transfer: [] };
			const positions = new Float32Array(owned.length * 3);
			for (let slot = 0; slot < owned.length; slot += 1) {
				const node = (owned[slot] ?? 0) * 3;
				positions[slot * 3] = simulation.positions[node] ?? 0;
				positions[slot * 3 + 1] = simulation.positions[node + 1] ?? 0;
				positions[slot * 3 + 2] = simulation.positions[node + 2] ?? 0;
			}
			return { reply: { positions, type: "rounded" }, transfer: [positions.buffer] };
		}
		if (shared) {
			for (const node of owned) {
				for (let axis = 0; axis < 3; axis += 1) shared[node * 3 + axis] = simulation.positions[node * 3 + axis] ?? 0;
			}
		}
		return { reply: { type: "published" }, transfer: [] };
	} catch (error) {
		return { reply: { message: error instanceof Error ? error.message : String(error), type: "error" }, transfer: [] };
	}
}

type WorkerScope = {
	onmessage: ((event: MessageEvent<RegionRequest>) => void) | null;
	postMessage(message: unknown, transfer: Transferable[]): void;
};

const scope = globalThis as unknown as WorkerScope & { WorkerGlobalScope?: new () => unknown };
// Importing this module elsewhere (tests, a host's own worker) must not hook the page's messages.
// A dedicated worker only hears the page that started it; its messages carry an empty origin.
if (typeof scope.WorkerGlobalScope === "function" && scope instanceof scope.WorkerGlobalScope) {
	const state: RegionWorkerState = {};
	scope.onmessage = ({ data, origin }) => {
		if (origin !== "") return;
		const { reply, transfer } = handleRegionMessage(state, data);
		scope.postMessage(reply, transfer);
	};
}
