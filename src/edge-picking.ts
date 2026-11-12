/** A straight world-space segment that can be hit-tested for edge picking. */
export interface PickableEdgeSegment {
	edgeIndex: number;
	/** Hit radius in CSS pixels, so a zoom changes what it covers in the world, not the segment. */
	hitSlop: number;
	x1: number;
	x2: number;
	y1: number;
	y2: number;
}

/** The hit-test copy of a drawn segment; `minHitSlop` is the smallest hit radius in CSS pixels. */
export function pickableSegment(
	segment: { edgeIndex: number; width: number; x1: number; x2: number; y1: number; y2: number },
	minHitSlop: number,
): PickableEdgeSegment {
	const { edgeIndex, x1, x2, y1, y2 } = segment;
	return { edgeIndex, hitSlop: Math.max(minHitSlop, segment.width / 2 + 2), x1, x2, y1, y2 };
}

/** Squared distance from a point to the closest point on a finite segment. */
export function distanceSquaredToSegment2d(
	px: number,
	py: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) {
		const ox = px - x1;
		const oy = py - y1;
		return ox * ox + oy * oy;
	}
	const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
	const closestX = x1 + t * dx;
	const closestY = y1 + t * dy;
	const ox = px - closestX;
	const oy = py - closestY;
	return ox * ox + oy * oy;
}

/**
 * Returns the edge index of the closest segment within its hit slop, or null.
 * When several edges qualify, the nearest wins; ties keep the first encountered edge index.
 */
export function pickClosestEdgeIndex(
	point: { x: number; y: number },
	segments: readonly PickableEdgeSegment[],
	worldUnitsPerPixel = 1,
): number | null {
	let nearestEdgeIndex: number | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;
	// forEach skips the unwritten slots of a sparse list.
	segments.forEach((segment) => {
		const distanceSquared = distanceSquaredToSegment2d(
			point.x,
			point.y,
			segment.x1,
			segment.y1,
			segment.x2,
			segment.y2,
		);
		const slop = segment.hitSlop * worldUnitsPerPixel;
		if (distanceSquared > slop * slop) return;
		if (distanceSquared < nearestDistance) {
			nearestDistance = distanceSquared;
			nearestEdgeIndex = segment.edgeIndex;
		}
	});
	return nearestEdgeIndex;
}
