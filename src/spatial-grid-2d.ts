import { resolveNodeAxes } from "./node-axes";
import { containsNodePoint } from "./node-shapes";
import type { GraphraumNodeGeometry } from "./types";

export interface Bounds2D {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

function nodeAxes(node: GraphraumNodeGeometry) {
	return resolveNodeAxes({ height: node.height, nodeId: node.id, size: node.size, width: node.width });
}

/**
 * Coarse occupancy radius for cell bucketing and bounding-box checks: half of the node's
 * larger axis, padded by its world-unit `strokeWidth`. This is intentionally conservative
 * (a circle-equivalent bound around a possibly non-square shape) — exact hit testing in
 * `pick` uses the true `width`/`height` per axis via `containsNodePoint`.
 */
function nodeOccupancyRadius(node: GraphraumNodeGeometry): number {
	const { height, width } = nodeAxes(node);
	return Math.max(width, height) + (node.strokeWidth ?? 0);
}

/** Upper bound on cells, so a huge world extent coarsens the cells instead of exhausting memory. */
const MAX_CELLS = 1 << 20;

/**
 * A uniform grid shared by 2D picking and viewport visibility queries. Cells are integers
 * (`row * columns + column`) in packed typed arrays: `cellStart` offsets into `cellItems`, a
 * counting sort of the node indices. A move inside its cell only updates the stored position; a
 * move across cells marks the packing stale and the next query repacks it in O(n).
 */
export class SpatialGrid2D {
	private readonly nodes: (GraphraumNodeGeometry | undefined)[] = [];
	private xs = new Float64Array(0);
	private ys = new Float64Array(0);
	private radii = new Float64Array(0);
	private cellOf = new Int32Array(0);
	private cellStart = new Int32Array(2);
	private cellItems = new Int32Array(0);
	private columns = 1;
	private rows = 1;
	private originX = 0;
	private originY = 0;
	private size: number;
	private stale = true;
	private maxRadius = 0;

	constructor(private readonly cellSize = 32) {
		if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error("Spatial grid cell size must be positive.");
		this.size = cellSize;
	}

	set(index: number, node: GraphraumNodeGeometry) {
		if (index >= this.xs.length) this.grow(Math.max(index + 1, this.xs.length * 2));
		const known = this.nodes[index] !== undefined;
		const radius = nodeOccupancyRadius(node);
		this.nodes[index] = node;
		this.xs[index] = node.position.x;
		this.ys[index] = node.position.y;
		this.radii[index] = radius;
		this.maxRadius = Math.max(this.maxRadius, radius);
		if (this.stale) return;
		const column = Math.floor((node.position.x - this.originX) / this.size);
		const row = Math.floor((node.position.y - this.originY) / this.size);
		const inside = column >= 0 && column < this.columns && row >= 0 && row < this.rows;
		if (!known || !inside || row * this.columns + column !== this.cellOf[index]) this.stale = true;
	}

	/**
	 * The node under a world point. `scales` (indexed like the nodes, 0 for none) and `maxScale` widen
	 * every hit area to the size a node is drawn at, for a renderer that scales nodes per frame.
	 */
	pick(x: number, y: number, scales?: Float32Array, maxScale = 1): number | null {
		this.pack();
		const cellRadius = Math.ceil((this.maxRadius * Math.max(maxScale, 1)) / this.size);
		const centerX = Math.floor((x - this.originX) / this.size);
		const centerY = Math.floor((y - this.originY) / this.size);
		let nearestIndex: number | null = null;
		let nearestDistance = Number.POSITIVE_INFINITY;

		const lastRow = Math.min(centerY + cellRadius, this.rows - 1);
		const lastColumn = Math.min(centerX + cellRadius, this.columns - 1);
		for (let row = Math.max(centerY - cellRadius, 0); row <= lastRow; row += 1) {
			for (let column = Math.max(centerX - cellRadius, 0); column <= lastColumn; column += 1) {
				const cell = row * this.columns + column;
				for (let item = this.cellStart[cell] as number; item < (this.cellStart[cell + 1] as number); item += 1) {
					const index = this.cellItems[item] as number;
					const node = this.nodes[index];
					if (!node) continue;
					const axes = nodeAxes(node);
					const scale = (scales?.[index] ?? 0) || 1;
					const width = axes.width * scale;
					const height = axes.height * scale;
					const offsetX = node.position.x - x;
					const offsetY = node.position.y - y;
					const distance = offsetX ** 2 + offsetY ** 2;
					if (containsNodePoint(node.shape, offsetX / width, offsetY / height) && distance < nearestDistance) {
						nearestDistance = distance;
						nearestIndex = index;
					}
				}
			}
		}
		return nearestIndex;
	}

	queryBounds(bounds: Bounds2D, overscan = 0): readonly number[] {
		this.pack();
		const left = bounds.left - overscan;
		const right = bounds.right + overscan;
		const bottom = bounds.bottom - overscan;
		const top = bounds.top + overscan;
		const indices: number[] = [];
		const firstColumn = this.cell((left - this.maxRadius - this.originX) / this.size, this.columns);
		const lastColumn = this.cell((right + this.maxRadius - this.originX) / this.size, this.columns);
		const lastRow = this.cell((top + this.maxRadius - this.originY) / this.size, this.rows);
		for (
			let row = this.cell((bottom - this.maxRadius - this.originY) / this.size, this.rows);
			row <= lastRow;
			row += 1
		) {
			// The cells of one row are adjacent in cellItems, so the row is a single run.
			const end = this.cellStart[row * this.columns + lastColumn + 1] as number;
			for (let item = this.cellStart[row * this.columns + firstColumn] as number; item < end; item += 1) {
				const index = this.cellItems[item] as number;
				const radius = this.radii[index] as number;
				const x = this.xs[index] as number;
				const y = this.ys[index] as number;
				if (x + radius >= left && x - radius <= right && y + radius >= bottom && y - radius <= top) indices.push(index);
			}
		}
		return indices;
	}

	/** Clamps a fractional cell coordinate into `[0, count)`; non-finite values land on the border. */
	private cell(value: number, count: number) {
		return value > 0 ? (value < count ? Math.floor(value) : count - 1) : 0;
	}

	private grow(capacity: number) {
		for (const key of ["xs", "ys", "radii"] as const) {
			const next = new Float64Array(capacity);
			next.set(this[key]);
			this[key] = next;
		}
		const cellOf = new Int32Array(capacity);
		cellOf.set(this.cellOf);
		this.cellOf = cellOf;
	}

	/** Counting sort of every node into the cells of a grid that fits their extent. */
	private pack() {
		if (!this.stale) return;
		this.stale = false;
		const present = [...this.nodes.keys()].filter((index) => this.nodes[index] !== undefined);
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const index of present) {
			minX = Math.min(minX, this.xs[index] as number);
			maxX = Math.max(maxX, this.xs[index] as number);
			minY = Math.min(minY, this.ys[index] as number);
			maxY = Math.max(maxY, this.ys[index] as number);
		}
		this.originX = Number.isFinite(minX) ? minX : 0;
		this.originY = Number.isFinite(minY) ? minY : 0;
		const spanX = Number.isFinite(maxX) ? maxX - this.originX : 0;
		const spanY = Number.isFinite(maxY) ? maxY - this.originY : 0;
		this.size = this.cellSize;
		while ((Math.floor(spanX / this.size) + 1) * (Math.floor(spanY / this.size) + 1) > MAX_CELLS) this.size *= 2;
		this.columns = Math.floor(spanX / this.size) + 1;
		this.rows = Math.floor(spanY / this.size) + 1;
		const cells = this.columns * this.rows;
		const starts = new Int32Array(cells + 1);
		for (const index of present) {
			const row = this.cell(((this.ys[index] as number) - this.originY) / this.size, this.rows);
			const column = this.cell(((this.xs[index] as number) - this.originX) / this.size, this.columns);
			this.cellOf[index] = row * this.columns + column;
			starts[(this.cellOf[index] as number) + 1] += 1;
		}
		for (let cell = 0; cell < cells; cell += 1) starts[cell + 1] += starts[cell] as number;
		const cursor = starts.slice(0, cells);
		this.cellItems = new Int32Array(present.length);
		for (const index of present) {
			const cell = this.cellOf[index] as number;
			this.cellItems[cursor[cell] as number] = index;
			cursor[cell] += 1;
		}
		this.cellStart = starts;
	}
}
