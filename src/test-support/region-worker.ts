/**
 * A region worker that runs in the calling thread, for tests: messages are structured-cloned like a real
 * worker's (so aliasing bugs show) and answered asynchronously, in order.
 */

import type { RegionReply, RegionRequest, RegionWorker } from "../layout-multilevel-regions";
import { handleRegionMessage, type RegionWorkerState } from "../layout-multilevel-worker";

export function inProcessRegionWorker(failOn?: RegionRequest["type"]): RegionWorker & Worker {
	const state: RegionWorkerState = {};
	const worker: RegionWorker = {
		onerror: null,
		onmessage: null,
		postMessage(message, transfer = []) {
			const copy = structuredClone(message, { transfer }) as RegionRequest;
			queueMicrotask(() => {
				if (failOn === copy.type) {
					worker.onerror?.({ message: `forced ${failOn} failure` });
					return;
				}
				const { reply, transfer: replyTransfer } = handleRegionMessage(state, copy);
				const delivered = structuredClone(reply, { transfer: replyTransfer }) as RegionReply;
				worker.onmessage?.({ data: delivered });
			});
		},
		terminate() {},
	};
	return worker as RegionWorker & Worker;
}
