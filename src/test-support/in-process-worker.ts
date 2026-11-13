import { serveClusterTreeWorker } from "../cluster-tree-job";

/** A worker that runs graphraum's real worker handler in this thread, with real structured-clone transfer so buffers detach. */
export function inProcessWorker(log: string[] = []): Worker {
	const scope = {
		onmessage: null as ((event: { data: unknown }) => void) | null,
		postMessage(message: unknown, transfer: Transferable[]) {
			const data = structuredClone(message, { transfer });
			// A timer, so the two steps arrive as separate tasks as they do from a real worker.
			setTimeout(() => worker.onmessage?.({ data } as MessageEvent), 0);
		},
	};
	const worker = {
		onerror: null,
		onmessage: null as ((event: MessageEvent) => void) | null,
		onmessageerror: null,
		postMessage(message: unknown, transfer: Transferable[] = []) {
			log.push("post");
			const data = structuredClone(message, { transfer });
			queueMicrotask(() => scope.onmessage?.({ data }));
		},
		terminate() {
			log.push("terminate");
		},
	};
	serveClusterTreeWorker(scope);
	return worker as unknown as Worker;
}
