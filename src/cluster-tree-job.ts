import {
	type ClusterTree,
	type ClusterTreeEdges,
	type ClusterTreeInput,
	clusterTreeTransferables,
	startClusterTree,
} from "./cluster-tree";

/** What the first step hands over: the tree without edges and the colour keys the caller gave. */
export interface ClusterTreeCoarse {
	buildMilliseconds: number;
	colors: Uint32Array | undefined;
	tree: ClusterTree;
}

/** What the second step hands over: the edge parts of the tree and the edge list the caller gave. */
export interface ClusterTreeFinished {
	buildMilliseconds: number;
	edgeList: Uint32Array;
	edges: ClusterTreeEdges;
}

export interface ClusterTreeJob {
	/** First step: resolves as soon as the clusters are shaped. */
	coarse: Promise<ClusterTreeCoarse>;
	/** Second step: resolves when the edges are aggregated. */
	finished: Promise<ClusterTreeFinished>;
	/** Stops a running worker. Pending promises reject. */
	terminate(): void;
	/** Whether a worker does the building. */
	usedWorker: boolean;
}

export interface ClusterTreeJobOptions {
	/** Creates the module worker. Default: `new Worker(new URL("./lod-worker.js", import.meta.url), { type: "module" })`. */
	createWorker?: () => Worker;
	/**
	 * Hand the input arrays to the worker instead of copying them (default true). They are detached on the caller's side,
	 * and the returned tree keeps what is needed. With false the caller keeps its arrays, and a worker that fails to
	 * start falls back to building on this thread.
	 */
	transfer?: boolean;
	/** False builds on this thread (the first step, a paint, then the second). Default: use a worker when the environment has one. */
	worker?: boolean;
}

type JobRequest = { input: ClusterTreeInput; type: "build" };
type JobResponse =
	| ({ type: "coarse" } & ClusterTreeCoarse)
	| ({ type: "finished" } & ClusterTreeFinished)
	| { message: string; type: "error" };

interface WorkerScope {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(message: unknown, transfer: Transferable[]): void;
}

type Emit = (response: JobResponse, transfer: Transferable[]) => void;

/** Runs both steps and reports each through `emit`. `pause` runs between them. */
async function runJob(input: ClusterTreeInput, emit: Emit, pause: () => Promise<void>) {
	const coarseStartedAt = performance.now();
	const build = startClusterTree(input);
	const coarse = { buildMilliseconds: performance.now() - coarseStartedAt, colors: input.colors, tree: build.tree };
	// `order` stays with the builder, which still reads it for the edges; the page gets a copy of it.
	emit({ ...coarse, type: "coarse" }, [
		...clusterTreeTransferables({ ...build.tree, order: null }),
		...(input.colors ? [input.colors.buffer as ArrayBuffer] : []),
	]);
	await pause();
	const finishedStartedAt = performance.now();
	const edges = build.completeEdges();
	const edgeList = input.edges ?? new Uint32Array(0);
	emit({ buildMilliseconds: performance.now() - finishedStartedAt, edgeList, edges, type: "finished" }, [
		...clusterTreeTransferables(edges),
		edgeList.buffer as ArrayBuffer,
	]);
}

/** Makes `scope` (a worker's `self`) build cluster trees. For a worker file of your own; graphraum's is `lod-worker.js`. */
export function serveClusterTreeWorker(scope: unknown): void {
	const worker = scope as WorkerScope;
	worker.onmessage = ({ data }) => {
		const request = data as JobRequest;
		runJob(
			request.input,
			(response, transfer) => worker.postMessage(response, transfer),
			() => Promise.resolve(),
		).catch((error: unknown) => {
			worker.postMessage({ message: error instanceof Error ? error.message : String(error), type: "error" }, []);
		});
	};
}

function createDefaultWorker(): Worker {
	return new Worker(new URL("./lod-worker.js", import.meta.url), { type: "module" });
}

/** Longest wait for a paint: a hidden tab runs no frame callbacks, and the second step must still happen. */
const PAINT_WAIT_MILLISECONDS = 100;

/** After a paint: a frame callback, then a timer, so the browser draws what the first step produced. */
function afterPaint(): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, PAINT_WAIT_MILLISECONDS);
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(done, 0));
	});
}

/** A view that owns its whole buffer can be transferred; any other is copied first so a transfer cannot detach its neighbours. */
function owning<T extends ArrayBufferView & { slice(): T }>(view: T): T {
	return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice();
}

function transferableInput(input: ClusterTreeInput): ClusterTreeInput {
	return {
		...input,
		...(input.colors ? { colors: owning(input.colors) } : {}),
		...(input.edges ? { edges: owning(input.edges) } : {}),
		positions: owning(input.positions),
		...(input.weights ? { weights: owning(input.weights) } : {}),
	};
}

interface Deferred<T> {
	promise: Promise<T>;
	reject(error: Error): void;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	// A caller that only waits for the first step must not trigger an unhandled rejection from the second.
	promise.catch(() => {});
	return { promise, reject, resolve };
}

/**
 * Builds a cluster tree in two steps, in a worker when there is one: the tree without edges first, so a view can
 * open early, then the edges. Without a worker the same steps run on this thread with a paint between them.
 */
export function startClusterTreeJob(input: ClusterTreeInput, options: ClusterTreeJobOptions = {}): ClusterTreeJob {
	const coarse = deferred<ClusterTreeCoarse>();
	const finished = deferred<ClusterTreeFinished>();
	let stop = () => {};
	const deliver = (response: JobResponse) => {
		if (response.type === "coarse") coarse.resolve(response);
		else if (response.type === "finished") finished.resolve(response);
		else {
			const error = new Error(`Cluster tree build failed: ${response.message}`);
			coarse.reject(error);
			finished.reject(error);
		}
	};
	const runHere = () => {
		let stopped = false;
		stop = () => {
			stopped = true;
			const error = new Error("Cluster tree build stopped.");
			coarse.reject(error);
			finished.reject(error);
		};
		runJob(
			input,
			(response) => {
				if (!stopped) deliver(response);
			},
			async () => {
				await afterPaint();
				if (stopped) throw new Error("Cluster tree build stopped.");
			},
		).catch((error: unknown) =>
			deliver({ message: error instanceof Error ? error.message : String(error), type: "error" }),
		);
	};

	const transfer = options.transfer !== false;
	const wantsWorker = options.worker !== false && (options.createWorker !== undefined || typeof Worker !== "undefined");
	let worker: Worker | null = null;
	if (wantsWorker) {
		try {
			worker = (options.createWorker ?? createDefaultWorker)();
		} catch {
			worker = null;
		}
	}
	if (!worker) {
		runHere();
		return { coarse: coarse.promise, finished: finished.promise, terminate: () => stop(), usedWorker: false };
	}

	const active = worker;
	let started = false;
	const fail = (message: string) => {
		active.terminate();
		if (!transfer && !started) {
			runHere();
			return;
		}
		deliver({ message, type: "error" });
	};
	active.onmessage = ({ data }: MessageEvent<JobResponse>) => {
		started = true;
		deliver(data);
		if (data.type !== "coarse") active.terminate();
	};
	active.onerror = (event) => fail(event.message || "the worker failed to start");
	active.onmessageerror = () => fail("the worker sent a message that could not be read");
	const payload = transfer ? transferableInput(input) : input;
	const request: JobRequest = { input: payload, type: "build" };
	active.postMessage(request, transfer ? clusterTreeTransferables(payload) : []);
	return {
		coarse: coarse.promise,
		finished: finished.promise,
		terminate() {
			active.terminate();
			const error = new Error("Cluster tree build stopped.");
			coarse.reject(error);
			finished.reject(error);
		},
		usedWorker: true,
	};
}
