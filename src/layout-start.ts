/**
 * Start positions for a force layout that keep long chains and strips unfolded: pivot MDS (Brandes and
 * Pich, 2006). Hop distances from `pivots` farthest-first pivots go through classical MDS on the n x k
 * distance matrix, solved as a k x k eigenproblem. O(k (n + E) + n k^2), deterministic (no random
 * numbers, ties go to the lowest node id). Lives in its own entry so the main bundle does not pay for it.
 */

/** Matches `DEFAULT_FORCE_SETTINGS.linkDistance`; a test keeps the two equal without importing the engine. */
const DEFAULT_LINK_DISTANCE = 24;
const DEFAULT_PIVOTS = 20;
const MAX_PIVOTS = 256;

/** What {@link pivotMdsPositions} needs from a force layout request. */
export interface PivotMdsRequest {
	dimensions: 2 | 3;
	edges: Uint32Array;
	/** Distance of one hop in the result. Omitted: 24, the default `ForceSettings.linkDistance`. Use the layout's value. */
	linkDistance?: number;
	nodeCount: number;
}

export interface PivotMdsOptions {
	/** Pivot nodes, an integer from 2 to 256. More pivots cost more and did not help in the fixtures. Omitted: 20. */
	pivots?: number;
}

/** Compressed adjacency; self loops and endpoints outside the node range are dropped. */
function adjacencyOf(nodeCount: number, edges: Uint32Array) {
	const rowPtr = new Uint32Array(nodeCount + 1);
	const valid = (source: number, target: number) => source !== target && source < nodeCount && target < nodeCount;
	for (let index = 0; index < edges.length; index += 2) {
		const source = edges[index] ?? 0;
		const target = edges[index + 1] ?? 0;
		if (!valid(source, target)) continue;
		rowPtr[source + 1] += 1;
		rowPtr[target + 1] += 1;
	}
	for (let node = 0; node < nodeCount; node += 1) rowPtr[node + 1] += rowPtr[node] ?? 0;
	const cursor = rowPtr.slice(0, nodeCount);
	const col = new Uint32Array(rowPtr[nodeCount] ?? 0);
	for (let index = 0; index < edges.length; index += 2) {
		const source = edges[index] ?? 0;
		const target = edges[index + 1] ?? 0;
		if (!valid(source, target)) continue;
		col[cursor[source]++] = target;
		col[cursor[target]++] = source;
	}
	return { col, rowPtr };
}

/** Hop distances from `source` into `distance` (-1 = not reached); returns the visit order. */
function breadthFirst(
	adjacency: ReturnType<typeof adjacencyOf>,
	source: number,
	distance: Int32Array,
	queue: Uint32Array,
) {
	distance.fill(-1);
	distance[source] = 0;
	queue[0] = source;
	let tail = 1;
	for (let head = 0; head < tail; head += 1) {
		const node = queue[head] ?? 0;
		for (let cursor = adjacency.rowPtr[node] ?? 0; cursor < (adjacency.rowPtr[node + 1] ?? 0); cursor += 1) {
			const next = adjacency.col[cursor] ?? 0;
			if (distance[next] !== -1) continue;
			distance[next] = (distance[node] ?? 0) + 1;
			queue[tail++] = next;
		}
	}
	return queue.subarray(0, tail);
}

/** Top `count` eigenvectors of the symmetric k x k matrix by orthogonal power iteration, largest first. */
function dominantEigenvectors(matrix: Float64Array, size: number, count: number) {
	const vectors = Array.from({ length: count }, (_, column) =>
		Float64Array.from({ length: size }, (_, row) => 1 + ((row * (column + 3) * 2654435761) % 1000) / 1000),
	);
	const eigenvalues = new Float64Array(count);
	for (let sweep = 0; sweep < 100; sweep += 1) {
		for (const [column, vector] of vectors.entries()) {
			const next = new Float64Array(size);
			for (let row = 0; row < size; row += 1) {
				let sum = 0;
				for (let k = 0; k < size; k += 1) sum += (matrix[row * size + k] ?? 0) * (vector[k] ?? 0);
				next[row] = sum;
			}
			for (const earlier of vectors.slice(0, column)) {
				let overlap = 0;
				for (let k = 0; k < size; k += 1) overlap += (next[k] ?? 0) * (earlier[k] ?? 0);
				for (let k = 0; k < size; k += 1) next[k] -= overlap * (earlier[k] ?? 0);
			}
			const norm = Math.hypot(...next);
			eigenvalues[column] = norm;
			for (let k = 0; k < size; k += 1) vector[k] = norm > 0 ? (next[k] ?? 0) / norm : 0;
		}
	}
	return { eigenvalues, vectors };
}

/** Classical MDS coordinates (hop units, centred) of one component from its pivot distance rows. */
function componentCoordinates(rows: Int32Array[], size: number, dimensions: number) {
	const pivots = rows.length;
	const squared = rows.map((row) => Float64Array.from(row, (hops) => hops * hops));
	const rowMean = new Float64Array(size);
	const columnMean = new Float64Array(pivots);
	let overall = 0;
	for (const [pivot, row] of squared.entries()) {
		for (let node = 0; node < size; node += 1) {
			rowMean[node] += (row[node] ?? 0) / pivots;
			columnMean[pivot] += (row[node] ?? 0) / size;
		}
		overall += (columnMean[pivot] ?? 0) / pivots;
	}
	const centred = squared.map((row, pivot) =>
		Float64Array.from(row, (value, node) => -0.5 * (value - (rowMean[node] ?? 0) - (columnMean[pivot] ?? 0) + overall)),
	);
	const gram = new Float64Array(pivots * pivots);
	for (let left = 0; left < pivots; left += 1) {
		for (let right = left; right < pivots; right += 1) {
			let sum = 0;
			const a = centred[left] as Float64Array;
			const b = centred[right] as Float64Array;
			for (let node = 0; node < size; node += 1) sum += (a[node] ?? 0) * (b[node] ?? 0);
			gram[left * pivots + right] = sum;
			gram[right * pivots + left] = sum;
		}
	}
	const { eigenvalues, vectors } = dominantEigenvectors(gram, pivots, dimensions);
	const largest = eigenvalues[0] ?? 0;
	return vectors.map((vector, axis) => {
		const coordinate = new Float64Array(size);
		// A near-zero eigenvalue is numerical noise (a path has no second dimension): leave that axis flat.
		if ((eigenvalues[axis] ?? 0) < 1e-6 * largest) return coordinate;
		for (let pivot = 0; pivot < pivots; pivot += 1) {
			const row = centred[pivot] as Float64Array;
			for (let node = 0; node < size; node += 1) coordinate[node] += (row[node] ?? 0) * (vector[pivot] ?? 0);
		}
		let strongest = 0;
		for (const value of coordinate) if (Math.abs(value) > Math.abs(strongest)) strongest = value;
		// Classical MDS coordinates are sqrt(mu) times the unit eigenvector u = C v / sqrt(lambda),
		// with mu ~ sqrt(lambda n / k) for the n x k pivot approximation of the n x n matrix.
		const lambda = eigenvalues[axis] ?? 1;
		const mu = Math.sqrt(Math.sqrt((lambda * size) / pivots));
		const factor = ((strongest < 0 ? -1 : 1) * mu) / Math.sqrt(lambda);
		return coordinate.map((value) => value * factor);
	});
}

function layoutHops(nodeCount: number, edges: Uint32Array, dimensions: 2 | 3, pivots: number): Float32Array {
	const positions = new Float32Array(nodeCount * 3).fill(Number.NaN);
	const adjacency = adjacencyOf(nodeCount, edges);
	const seen = new Uint8Array(nodeCount);
	const distance = new Int32Array(nodeCount);
	const queue = new Uint32Array(nodeCount);
	interface Placed {
		half: number[];
		members: Uint32Array;
		coordinates: Float64Array[];
	}
	const placed: Placed[] = [];
	for (let root = 0; root < nodeCount; root += 1) {
		if (seen[root] || (adjacency.rowPtr[root + 1] ?? 0) === (adjacency.rowPtr[root] ?? 0)) continue;
		const members = Uint32Array.from(breadthFirst(adjacency, root, distance, queue));
		for (const member of members) seen[member] = 1;
		const size = members.length;
		const local = new Map<number, number>();
		for (const [index, member] of members.entries()) local.set(member, index);
		const sorted = Uint32Array.from(members).sort();
		const rows: Int32Array[] = [];
		const nearest = new Int32Array(size).fill(2 ** 30);
		let pivot = sorted[0] ?? root;
		for (let count = 0; count < Math.min(pivots, size); count += 1) {
			breadthFirst(adjacency, pivot, distance, queue);
			rows.push(Int32Array.from(members, (member) => distance[member] ?? 0));
			let best = -1;
			let farthest = -1;
			for (const member of sorted) {
				const index = local.get(member) ?? 0;
				nearest[index] = Math.min(nearest[index] ?? 0, distance[member] ?? 0);
				if ((nearest[index] ?? 0) > farthest) {
					farthest = nearest[index] ?? 0;
					best = member;
				}
			}
			if (farthest <= 0) break;
			pivot = best;
		}
		const coordinates = componentCoordinates(rows, size, dimensions);
		const half = coordinates.map((axis) => {
			let mean = 0;
			for (const value of axis) mean += value / size;
			let reach = 0;
			for (let index = 0; index < size; index += 1) {
				axis[index] -= mean;
				reach = Math.max(reach, Math.abs(axis[index] ?? 0));
			}
			return reach;
		});
		placed.push({ coordinates, half, members });
	}
	// Shelf packing in X/Y: tallest components first, rows as wide as the square root of the total area.
	placed.sort(
		(left, right) => (right.half[1] ?? 0) - (left.half[1] ?? 0) || (left.members[0] ?? 0) - (right.members[0] ?? 0),
	);
	const gap = 2;
	const area = placed.reduce((sum, item) => sum + (2 * (item.half[0] ?? 0) + gap) * (2 * (item.half[1] ?? 0) + gap), 0);
	const rowWidth = Math.max(Math.sqrt(area) * 1.5, ...placed.map((item) => 2 * (item.half[0] ?? 0) + gap));
	let cursorX = 0;
	let cursorY = 0;
	let rowHeight = 0;
	const origins: [number, number][] = [];
	for (const item of placed) {
		const width = 2 * (item.half[0] ?? 0) + gap;
		const height = 2 * (item.half[1] ?? 0) + gap;
		if (cursorX > 0 && cursorX + width > rowWidth) {
			cursorY += rowHeight;
			cursorX = 0;
			rowHeight = 0;
		}
		origins.push([cursorX + width / 2, cursorY + height / 2]);
		cursorX += width;
		rowHeight = Math.max(rowHeight, height);
	}
	const totalHeight = cursorY + rowHeight;
	const totalWidth = Math.max(
		...placed.map((_, index) => (origins[index]?.[0] ?? 0) + (placed[index]?.half[0] ?? 0)),
		0,
	);
	for (const [index, item] of placed.entries()) {
		const [originX, originY] = origins[index] ?? [0, 0];
		for (const [slot, member] of item.members.entries()) {
			positions[member * 3] = (item.coordinates[0]?.[slot] ?? 0) + originX - totalWidth / 2;
			positions[member * 3 + 1] = (item.coordinates[1]?.[slot] ?? 0) + originY - totalHeight / 2;
			positions[member * 3 + 2] = dimensions === 3 ? (item.coordinates[2]?.[slot] ?? 0) : 0;
		}
	}
	return positions;
}

/**
 * `initialPositions` for a force layout: every node with an edge is placed from graph distances, one hop
 * `linkDistance` apart, so a chain starts as a line. Components are packed side by side in rows. An
 * isolated node gets `NaN`, which keeps the layout's default start for it. Deterministic.
 *
 * ```ts
 * const positions = computeForcePositions({
 *   ...request,
 *   initialPositions: pivotMdsPositions(request),
 * });
 * ```
 */
export function pivotMdsPositions(request: PivotMdsRequest, options: PivotMdsOptions = {}): Float32Array {
	const { dimensions, edges, nodeCount } = request;
	const linkDistance = request.linkDistance ?? DEFAULT_LINK_DISTANCE;
	const pivots = options.pivots ?? DEFAULT_PIVOTS;
	if (dimensions !== 2 && dimensions !== 3) throw new Error("Pivot MDS dimensions must be 2 or 3.");
	if (!Number.isSafeInteger(nodeCount) || nodeCount < 0)
		throw new Error("Pivot MDS node count must be a non-negative integer.");
	if (edges.length % 2 !== 0) throw new Error("Pivot MDS edges must contain source/target pairs.");
	if (!Number.isFinite(linkDistance) || linkDistance <= 0)
		throw new Error("Pivot MDS link distance must be a positive number.");
	if (!Number.isInteger(pivots) || pivots < 2 || pivots > MAX_PIVOTS) {
		throw new Error(`Pivot MDS pivots must be an integer from 2 to ${MAX_PIVOTS}.`);
	}
	const positions = layoutHops(nodeCount, edges, dimensions, pivots);
	for (let index = 0; index < positions.length; index += 1) positions[index] *= linkDistance;
	return positions;
}
