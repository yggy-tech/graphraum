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

/** A mutable uniform grid shared by 2D picking and viewport visibility queries. */
export class SpatialGrid2D {
	private readonly cells = new Map<string, number[]>();
	private readonly cellKeys: (string | undefined)[] = [];
	private readonly nodes: (GraphraumNodeGeometry | undefined)[] = [];
	private maxRadius = 0;

	constructor(private readonly cellSize = 32) {
		if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error("Spatial grid cell size must be positive.");
	}

	set(index: number, node: GraphraumNodeGeometry) {
		const previousKey = this.cellKeys[index];
		if (previousKey) {
			const previousCell = this.cells.get(previousKey);
			if (previousCell) {
				const position = previousCell.indexOf(index);
				if (position >= 0) previousCell.splice(position, 1);
				if (previousCell.length === 0) this.cells.delete(previousKey);
			}
		}

		const key = this.key(this.coordinate(node.position.x), this.coordinate(node.position.y));
		const cell = this.cells.get(key) ?? [];
		cell.push(index);
		this.cells.set(key, cell);
		this.cellKeys[index] = key;
		this.nodes[index] = node;
		this.maxRadius = Math.max(this.maxRadius, nodeOccupancyRadius(node));
	}

	/**
	 * The node under a world point. `scales` (indexed like the nodes, 0 for none) and `maxScale` widen
	 * every hit area to the size a node is drawn at, for a renderer that scales nodes per frame.
	 */
	pick(x: number, y: number, scales?: Float32Array, maxScale = 1): number | null {
		const cellRadius = Math.ceil((this.maxRadius * Math.max(maxScale, 1)) / this.cellSize);
		const centerX = this.coordinate(x);
		const centerY = this.coordinate(y);
		let nearestIndex: number | null = null;
		let nearestDistance = Number.POSITIVE_INFINITY;

		for (let cellY = centerY - cellRadius; cellY <= centerY + cellRadius; cellY += 1) {
			for (let cellX = centerX - cellRadius; cellX <= centerX + cellRadius; cellX += 1) {
				for (const index of this.cells.get(this.key(cellX, cellY)) ?? []) {
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
		const left = bounds.left - overscan;
		const right = bounds.right + overscan;
		const bottom = bounds.bottom - overscan;
		const top = bounds.top + overscan;
		const indices: number[] = [];
		const minimumCellX = this.coordinate(left - this.maxRadius);
		const maximumCellX = this.coordinate(right + this.maxRadius);
		const minimumCellY = this.coordinate(bottom - this.maxRadius);
		const maximumCellY = this.coordinate(top + this.maxRadius);
		const queriedCellCount = (maximumCellX - minimumCellX + 1) * (maximumCellY - minimumCellY + 1);
		const candidateCells: Iterable<readonly number[]> =
			Number.isSafeInteger(queriedCellCount) && queriedCellCount <= this.cells.size
				? this.cellsInBounds(minimumCellX, maximumCellX, minimumCellY, maximumCellY)
				: this.cells.values();
		for (const cell of candidateCells) {
			for (const index of cell) {
				const node = this.nodes[index];
				if (!node) continue;
				const radius = nodeOccupancyRadius(node);
				if (
					node.position.x + radius >= left &&
					node.position.x - radius <= right &&
					node.position.y + radius >= bottom &&
					node.position.y - radius <= top
				) {
					indices.push(index);
				}
			}
		}
		return indices;
	}

	private *cellsInBounds(minimumX: number, maximumX: number, minimumY: number, maximumY: number) {
		for (let y = minimumY; y <= maximumY; y += 1) {
			for (let x = minimumX; x <= maximumX; x += 1) yield this.cells.get(this.key(x, y)) ?? [];
		}
	}

	private coordinate(value: number) {
		return Math.floor(value / this.cellSize);
	}

	private key(x: number, y: number) {
		return `${x}:${y}`;
	}
}
