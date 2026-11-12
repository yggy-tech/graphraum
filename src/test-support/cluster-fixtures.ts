/** Seeded synthetic data for the cluster tree and cut tests. */
function random(seed: number) {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

export function scatter(count: number, dimensions: 2 | 3, seed = 1) {
	const next = random(seed);
	return Float32Array.from({ length: count * dimensions }, () => next() * 1000);
}

export function randomEdges(count: number, edgeCount: number, seed = 2) {
	const next = random(seed);
	return Uint32Array.from({ length: edgeCount * 2 }, () => Math.floor(next() * count));
}
