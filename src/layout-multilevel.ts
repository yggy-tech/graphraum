/**
 * Multilevel force layout (the sfdp and FM3 family): merge nodes into groups level by level until a few
 * hundred super-nodes remain, lay those out with the regular force layout, then place every node at its
 * group's position and refine each finer level with a few steps. Each level is a normal graph for the
 * force layout, so both layout styles, clusters and anchors work unchanged. Lives in its own entry so the
 * main and layout bundles do not pay for it.
 */

import {
	computeForcePositions,
	createForceSimulation,
	DEFAULT_FORCE_SETTINGS,
	FORCE_LAYOUT_STYLE_PRESETS,
	type ForceAnchors,
	type ForceLayoutRequest,
} from "./force-layout";
import { baseCoarseLevel, type CoarseLevel, coarsenGraph, levelEdges } from "./graph-coarsen";

export type { ForceLayoutRequest } from "./force-layout";

/** The phases {@link MultilevelOptions.onProgress} reports. */
export type MultilevelPhase = "coarsen" | "coarsest" | "refine";

/** One finished phase of a multilevel layout, for timing. */
export interface MultilevelProgress {
	/** 0 is the full graph; higher levels are coarser. The coarsening reports the coarsest level it built. */
	level: number;
	/** Wall time of the phase. */
	milliseconds: number;
	/** Nodes at that level. */
	nodeCount: number;
	phase: MultilevelPhase;
}

/** Tuning for {@link computeMultilevelForcePositions}; every field is optional. */
export interface MultilevelOptions {
	/**
	 * Stop coarsening at this many super-nodes, an integer from 8 to 5 000. Fewer is faster but gives the
	 * coarsest layout less to work with. Omitted: 200.
	 */
	coarsestSize?: number;
	/** Most coarsening levels, an integer from 1 to 32. Omitted: as many as `coarsestSize` needs. */
	levels?: number;
	/**
	 * Called once with the whole graph placed from the coarsest layout, before any refinement. These are
	 * rough but already show the global shape, so a host can display them while the refinement runs. The
	 * array is not reused.
	 */
	onPreview?: (positions: Float32Array) => void;
	/** Called after the coarsening, the coarsest layout and each refined level, for timing. */
	onProgress?: (progress: MultilevelProgress) => void;
	/**
	 * Force steps on the full graph after the coarsest layout, an integer from 1 to 16. Each coarser
	 * level gets one more (they are smaller, and the global shape is set there), capped at 16.
	 * `"edge-t"` runs twice as many. Omitted: 2.
	 */
	refineSteps?: number;
	/** Changes the random choices of the coarsening and the placement jitter. Omitted: 0. */
	seed?: number;
}

const DEFAULT_COARSEST_SIZE = 200;
const DEFAULT_REFINE_STEPS = 2;
/** Alpha of the first refinement step; it falls linearly to zero over the level's steps. */
const REFINE_ALPHA = 0.4;
/** The most steps one level gets: coarser levels take one more step each, since they are small. */
const MAX_LEVEL_STEPS = 16;

function integerOption(name: string, value: number | undefined, fallback: number, min: number, max: number) {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer from ${min} to ${max}; got ${value}.`);
	}
	return value;
}

function hash32(seed: number) {
	let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
	value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
	return (value ^ (value >>> 16)) >>> 0;
}

function random(seed: number) {
	return hash32(seed) / 0x1_0000_0000;
}

/** Mean of the known values per coarse node; NaN where no member has one. A node is known when its first `axes` values are. */
function meanByParent(values: Float32Array, stride: number, axes: number, parent: Uint32Array, count: number) {
	const sums = new Float64Array(count * stride);
	const known = new Uint32Array(count);
	for (let node = 0; node < parent.length; node += 1) {
		let finite = true;
		for (let axis = 0; axis < axes; axis += 1) finite &&= !Number.isNaN(values[node * stride + axis]);
		if (!finite) continue;
		const target = parent[node] ?? 0;
		known[target] += 1;
		for (let axis = 0; axis < stride; axis += 1) sums[target * stride + axis] += values[node * stride + axis] ?? 0;
	}
	const result = new Float32Array(count * stride).fill(Number.NaN);
	for (let target = 0; target < count; target += 1) {
		if (!known[target]) continue;
		for (let axis = 0; axis < stride; axis += 1) {
			result[target * stride + axis] = (sums[target * stride + axis] ?? 0) / (known[target] ?? 1);
		}
	}
	return result;
}

/** The per-node inputs of the request, carried to each coarser level. */
interface LevelInputs {
	anchors?: ForceAnchors;
	initialPositions?: Float32Array;
}

function coarsenInputs(inputs: LevelInputs, level: CoarseLevel, dimensions: 2 | 3, unit: number): LevelInputs {
	const parent = level.parent as Uint32Array;
	const next: LevelInputs = {};
	if (inputs.initialPositions) {
		// The start is in layout units of the full graph; a coarse level lays out in its own, `unit` times smaller.
		next.initialPositions = meanByParent(inputs.initialPositions, 3, dimensions, parent, level.nodeCount).map(
			(value) => value / unit,
		);
	}
	if (inputs.anchors) {
		const strength = inputs.anchors.strength;
		next.anchors = {
			positions: meanByParent(inputs.anchors.positions, dimensions, dimensions, parent, level.nodeCount),
			strength: strength instanceof Float32Array ? meanByParent(strength, 1, 0, parent, level.nodeCount) : strength,
		};
	}
	return next;
}

/** Positions of the nodes of `fine` from the positions of their groups in `coarse`, `scale` times larger. */
function prolong(
	coarse: Float32Array,
	fine: CoarseLevel,
	coarseLevel: CoarseLevel,
	dimensions: 2 | 3,
	scale: number,
	linkDistance: number,
	seed: number,
) {
	const parent = coarseLevel.parent as Uint32Array;
	const children = new Uint32Array(coarseLevel.nodeCount);
	for (const group of parent) children[group] += 1;
	const positions = new Float32Array(fine.nodeCount * 3);
	const exponent = 1 / dimensions;
	for (let node = 0; node < fine.nodeCount; node += 1) {
		const group = parent[node] ?? 0;
		// A group of k children spreads over about k link distances of area (or volume).
		const radius = 0.5 * linkDistance * (children[group] ?? 1) ** exponent;
		const angle = random(node * 4 + seed + 1) * Math.PI * 2;
		const offset =
			radius * (dimensions === 2 ? Math.sqrt(random(node * 4 + seed + 2)) : Math.cbrt(random(node * 4 + seed + 3)));
		const zDirection = dimensions === 3 ? random(node * 4 + seed + 4) * 2 - 1 : 0;
		const plane = Math.sqrt(1 - zDirection * zDirection);
		positions[node * 3] = (coarse[group * 3] ?? 0) * scale + Math.cos(angle) * plane * offset;
		positions[node * 3 + 1] = (coarse[group * 3 + 1] ?? 0) * scale + Math.sin(angle) * plane * offset;
		positions[node * 3 + 2] = dimensions === 3 ? (coarse[group * 3 + 2] ?? 0) * scale + zDirection * offset : 0;
	}
	return positions;
}

/**
 * Multilevel force layout for large graphs: `nodeCount * 3` positions (Z stays 0 in 2D), like
 * `computeForcePositions()` and taking the same request: both layout styles, `clusters`, `anchors`,
 * `initialPositions`, `settings`, `linkDistances` and `springStrengths` (the last two apply to the full
 * graph). Groups never merge across `clusters`. `initialPositions` and `anchors` are averaged per group
 * to start the coarsest layout. `iterations` sets the coarsest layout; `warmStart` skips the coarse
 * levels and behaves like `computeForcePositions()`, since a settled layout needs no coarse pass.
 * Graphs of at most `coarsestSize` nodes also use the plain force layout. Deterministic for a `seed`.
 */
export function computeMultilevelForcePositions(
	request: ForceLayoutRequest,
	options: MultilevelOptions = {},
): Float32Array {
	const coarsestSize = integerOption("coarsestSize", options.coarsestSize, DEFAULT_COARSEST_SIZE, 8, 5_000);
	const maxLevels = integerOption("levels", options.levels, 32, 1, 32);
	const refineSteps = integerOption("refineSteps", options.refineSteps, DEFAULT_REFINE_STEPS, 1, 16);
	const seed = integerOption("seed", options.seed, 0, 0, 0xffff_ffff);
	if (request.edges.length % 2 !== 0) throw new Error("Edges must contain source/target pairs.");
	if (request.warmStart || request.nodeCount <= coarsestSize) return computeForcePositions(request);

	const { dimensions } = request;
	const report = (phase: MultilevelPhase, level: number, nodeCount: number, startedAt: number) =>
		options.onProgress?.({ level, milliseconds: performance.now() - startedAt, nodeCount, phase });
	const coarsenStartedAt = performance.now();
	const finest = baseCoarseLevel(request.nodeCount, request.edges, request.clusters);
	const levels = coarsenGraph(finest, { coarsestSize, maxLevels, seed });
	report("coarsen", levels.length - 1, (levels[levels.length - 1] as CoarseLevel).nodeCount, coarsenStartedAt);
	if (levels.length === 1) return computeForcePositions(request);

	const settings = { ...DEFAULT_FORCE_SETTINGS, ...request.settings };
	const linkDistance = Number.isFinite(settings.linkDistance)
		? settings.linkDistance
		: DEFAULT_FORCE_SETTINGS.linkDistance;
	const style = FORCE_LAYOUT_STYLE_PRESETS[settings.layoutStyle] ?? FORCE_LAYOUT_STYLE_PRESETS.classic;
	// Each coarse level lays out in its own units: `units[level]` full-graph units per unit of that level.
	const units = levels.map((level) => (request.nodeCount / level.nodeCount) ** (1 / dimensions));
	const inputs: LevelInputs[] = [{ anchors: request.anchors, initialPositions: request.initialPositions }];
	for (let level = 1; level < levels.length; level += 1) {
		const coarse = levels[level] as CoarseLevel;
		const unit = (units[level] ?? 1) / (units[level - 1] ?? 1);
		inputs.push(coarsenInputs(inputs[level - 1] as LevelInputs, coarse, dimensions, unit));
	}

	const top = levels.length - 1;
	const coarsest = levels[top] as CoarseLevel;
	const coarsestStartedAt = performance.now();
	const coarsestEdges = levelEdges(coarsest);
	let positions = computeForcePositions({
		anchors: inputs[top]?.anchors,
		clusters: coarsest.groups ?? undefined,
		dimensions,
		edges: coarsestEdges.edges,
		initialPositions: inputs[top]?.initialPositions,
		iterations: request.iterations,
		nodeCount: coarsest.nodeCount,
		settings: request.settings,
		springStrengths: weightedSprings(coarsestEdges.weights, settings.springStrength),
	});
	report("coarsest", top, coarsest.nodeCount, coarsestStartedAt);

	if (options.onPreview) {
		let preview = positions;
		for (let level = top; level > 0; level -= 1) {
			const scale = (units[level] ?? 1) / (units[level - 1] ?? 1);
			preview = prolong(
				preview,
				levels[level - 1] as CoarseLevel,
				levels[level] as CoarseLevel,
				dimensions,
				scale,
				linkDistance,
				seed,
			);
		}
		options.onPreview(preview);
	}

	for (let level = top - 1; level >= 0; level -= 1) {
		const refineStartedAt = performance.now();
		const fine = levels[level] as CoarseLevel;
		const start = prolong(
			positions,
			fine,
			levels[level + 1] as CoarseLevel,
			dimensions,
			(units[level + 1] ?? 1) / (units[level] ?? 1),
			linkDistance,
			seed,
		);
		const own = level === 0;
		const edges = own ? { edges: request.edges, weights: null } : levelEdges(fine);
		const simulation = createForceSimulation({
			anchors: inputs[level]?.anchors,
			clusters: own ? request.clusters : (fine.groups ?? undefined),
			dimensions,
			edges: edges.edges,
			initialPositions: start,
			linkDistances: own ? request.linkDistances : undefined,
			nodeCount: fine.nodeCount,
			settings: request.settings,
			springStrengths: own
				? request.springStrengths
				: weightedSprings(edges.weights as Float32Array, settings.springStrength),
			warmStart: true,
		});
		const steps = Math.min(MAX_LEVEL_STEPS, (refineSteps + level) * (style.iterationScale > 1 ? 2 : 1));
		for (let step = 0; step < steps; step += 1) simulation.step(REFINE_ALPHA * (1 - step / steps));
		positions = simulation.positions;
		report("refine", level, fine.nodeCount, refineStartedAt);
	}
	return positions;
}

/** Heavier merged edges pull harder, up to 8 times the base spring. */
function weightedSprings(weights: Float32Array, base: number) {
	return weights.map((weight) => base * Math.min(8, Math.sqrt(weight)));
}
