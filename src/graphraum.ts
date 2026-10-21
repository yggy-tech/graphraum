import {
	Box3,
	CanvasTexture,
	Color,
	type InstancedBufferAttribute,
	InstancedMesh,
	type Material,
	Matrix4,
	MeshBasicMaterial,
	OrthographicCamera,
	PerspectiveCamera,
	Plane,
	Raycaster,
	RepeatWrapping,
	Scene,
	SphereGeometry,
	SRGBColorSpace,
	Texture,
	Vector2,
	Vector3,
	WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { autoRotateSpeedFor, resolveAutoOrbitOptions } from "./auto-orbit";
import { AutoOrbitLoop } from "./auto-orbit-loop";
import { applyPerspectiveContainerAspect, containerAspect } from "./camera-aspect";
import { easeInOutCubic, flightProgress, interpolateScale, resolveFlyToOptions } from "./camera-flight";
import { perspectiveClipRange, validateCameraState } from "./camera-state";
import { compileGraph } from "./compile-graph";
import { dataPatchFitsCapacity, isAppendOnlyDataPatch, type MergedGraphData, mergeDataPatch } from "./data-patch";
import { edgeTierFromDiagnosticsLod, packEdgeInstances } from "./edge-materialize";
import { DETAIL_MAX_SEGMENTS, type EdgeLodTier } from "./edge-paths";
import { type PickableEdgeSegment, pickClosestEdgeIndex } from "./edge-picking";
import {
	createEdgeGeometry,
	createEdgeMaterial,
	EDGE_INSTANCE_ATTRIBUTES,
	EDGE_RENDER_ORDER,
	writeEdgeMarkerInstance,
	writeEdgeSegmentInstance,
} from "./edge-rendering";
import { changedIds, type EdgeStateStyling } from "./edge-state";
import {
	buildVisibleEdgeLayouts,
	patchVisibleEdgeInstances,
	patchVisibleEdgePaint,
	type VisibleEdgeLayout,
} from "./edge-viewport-patch";
import { fitPerspective, type PerspectiveFit } from "./fit-3d";
import { markInstanceColorSlots } from "./instance-color-ranges";
import { prepareLayoutPositions } from "./layout-positions";
import { resolveNodeAxes } from "./node-axes";
import { glowBlendModeFor, glowHaloRadius } from "./node-glow";
import { type GlowNodeTarget, NodeGlowLayer } from "./node-glow-rendering";
import {
	allocateNodeInstanceColors,
	createNodeGeometry,
	createNodeMaterial,
	NODE_RENDER_ORDER,
	setNodeShapeAt,
	setNodeStrokeAt,
} from "./node-rendering";
import { containsNodePoint } from "./node-shapes";
import { resolveNodeStroke } from "./node-stroke";
import { type PreparedNodeUpdate, prepareNodeUpdates } from "./node-updates";
import { configureControlsForMode } from "./orbit-controls-mode";
import { GraphraumOverlay } from "./overlay";
import { type Bounds2D, SpatialGrid2D } from "./spatial-grid-2d";
import { normalizeGraphraumBackground, resolveGraphraumTheme } from "./theme";
import type {
	CompiledGraphraumPresentation,
	GraphraumAutoOrbitOptions,
	GraphraumBackground,
	GraphraumCameraState,
	GraphraumData,
	GraphraumDataPatch,
	GraphraumDiagnostics,
	GraphraumEdgeState,
	GraphraumFlyToOptions,
	GraphraumLabelCandidate,
	GraphraumLayoutPositions,
	GraphraumMode,
	GraphraumNodeState,
	GraphraumNodeUpdate,
	GraphraumOptions,
	GraphraumOverlayOptions,
	GraphraumPickHit,
	GraphraumScreenPosition,
	GraphraumSetDataOptions,
	GraphraumTheme,
	GraphraumThemeName,
	GraphraumVisualMapper,
} from "./types";
import { applyEdgeBudget, collectIncidentEdges, resolveLodLevel, shouldUseDensityLod } from "./viewport-lod";

/** Importance boost so selected nodes stay labeled when autoLabels budgets the overlay. */
const SELECTED_LABEL_IMPORTANCE_BOOST = 1000;
/** The 3D fit leaves 4% of the tighter canvas axis free on each side, e.g. for edge labels. */
const PERSPECTIVE_FIT_FILL = 0.92;

type GraphraumCamera = OrthographicCamera | PerspectiveCamera;
type GraphraumNodes<NodeAttributes> = GraphraumData<NodeAttributes, unknown>["nodes"];

/** Where a 2D fit puts the orthographic camera: centre, unzoomed visible height and camera z. */
interface OrthographicFit {
	cameraZ: number;
	center: Vector3;
	visibleHeight: number;
}

/** One planned camera move. `step` places the camera at an eased progress; `arrive` settles it. */
interface CameraFlight {
	arrive(): void;
	step(eased: number): void;
}

interface ActiveCameraFlight extends CameraFlight {
	readonly durationMs: number;
	resolve(arrived: boolean): void;
	startMs: number | null;
}

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}
type GraphraumGraphObjects = {
	edgeMesh: InstancedMesh;
	nodeMesh: InstancedMesh;
	nodePickMesh: InstancedMesh;
};

interface MaterializedNode {
	height: number;
	index: number;
	width: number;
	x: number;
	y: number;
	z: number;
}

interface GpuTimer {
	extension: { GPU_DISJOINT_EXT: number; TIME_ELAPSED_EXT: number };
	context: WebGL2RenderingContext;
	pending: WebGLQuery[];
}

function disposeMaterial(material: Material | Material[]) {
	for (const item of Array.isArray(material) ? material : [material]) item.dispose();
}

/** Canvas input that cancels a running `flyTo`, so people take over the camera at once. */
const FLIGHT_CANCEL_EVENTS = ["keydown", "pointerdown", "wheel"] as const;

/** A small, explicit WebGL graph renderer: one instanced node mesh and one batched edge geometry. */
export class Graphraum<NodeAttributes = undefined, EdgeAttributes = undefined> {
	private readonly container: HTMLElement;
	private readonly renderer: WebGLRenderer;
	private readonly scene = new Scene();
	private readonly raycaster = new Raycaster();
	private readonly pointer = new Vector2();
	private readonly pickCenter = new Vector3();
	private readonly pickRight = new Vector3();
	private readonly pickUp = new Vector3();
	private theme: GraphraumTheme;
	private backgroundTexture: Texture | null = null;
	private readonly resizeObserver: ResizeObserver;
	private readonly maxVisibleEdges: number;
	private readonly maxVisibleNodes: number;
	private readonly viewportCulling: boolean;
	private readonly viewportOverscan: number;
	private readonly visuals: GraphraumVisualMapper<NodeAttributes, EdgeAttributes> | undefined;
	private camera: GraphraumCamera;
	private controls: OrbitControls;
	private data: GraphraumData<NodeAttributes, EdgeAttributes> = { nodes: [], edges: [] };
	private nodeIds: readonly string[] = [];
	private nodeIndices = new Map<string, number>();
	private edgeNodeIndices: Uint32Array = new Uint32Array();
	private canonicalEdgePositions: Float32Array = new Float32Array();
	private incidentEdgeIndices: readonly (readonly number[])[] = [];
	private nodePresentations = new Map<string, CompiledGraphraumPresentation>();
	private edgePresentations = new Map<string, CompiledGraphraumPresentation>();
	private spatialGrid2d = new SpatialGrid2D();
	private nodeMesh: InstancedMesh | null = null;
	private nodePickMesh: InstancedMesh | null = null;
	private edgeMesh: InstancedMesh | null = null;
	private readonly glowLayer = new NodeGlowLayer(this.scene);
	private hasGlowNodes = false;
	private nodeCapacity = 0;
	private edgeCapacity = 0;
	private markerCapacity = 0;
	private edgeInstanceCapacity = 0;
	private selectedNodeIds = new Set<string>();
	private selectedEdgeIds = new Set<string>();
	private dimmedEdgeIds = new Set<string>();
	private edgeIndexCache: { edges: readonly unknown[]; indices: Map<string, number> } = {
		edges: [],
		indices: new Map(),
	};
	private hoveredNodeIds = new Set<string>();
	private focusedNodeIds = new Set<string>();
	private dimmedNodeIds = new Set<string>();
	private visibleNodeSlots = new Map<number, number>();
	private visibleEdgeSlots = new Map<number, number>();
	private visibleEdgeLayouts = new Map<number, VisibleEdgeLayout>();
	private lastEdgeLodTier: EdgeLodTier = "detail";
	private visibleNodeIndices: readonly number[] = [];
	private pickableEdgeSegments: PickableEdgeSegment[] = [];
	private visibleEdgeSegmentEdgeIndices: number[] = [];
	private visibleNodeCount = 0;
	private visibleNodeCandidateCount = 0;
	private densityLodActive = false;
	private visibleEdgeSegmentCount = 0;
	private visibleEdgeCount = 0;
	private visibleEdgeMarkerCount = 0;
	private visibleEdgeCandidateCount = 0;
	private edgeSegmentCapacity = 0;
	private mode: GraphraumMode;
	private frameRequest: number | null = null;
	private autoOrbit: AutoOrbitLoop | null = null;
	private flight: ActiveCameraFlight | null = null;
	private readonly flightDirection = new Vector3();
	/** True only during the orbit's own `controls.update(dt)`; see `handleViewChange`. */
	private orbitUpdating = false;
	private destroyed = false;
	private canvasWidth = 0;
	private canvasHeight = 0;
	private cpuFrameMilliseconds = 0;
	private gpuFrameMilliseconds: number | null = null;
	private gpuTimer: GpuTimer | null = null;
	private readonly viewListeners = new Set<() => void>();
	private readonly focusListeners = new Set<() => void>();
	private lastHoveredNodeId: string | null = null;

	constructor(container: HTMLElement, options: GraphraumOptions<NodeAttributes, EdgeAttributes> = {}) {
		this.container = container;
		this.mode = options.mode ?? "2d";
		this.maxVisibleEdges = options.maxVisibleEdges ?? 100_000;
		this.maxVisibleNodes = options.maxVisibleNodes ?? 100_000;
		this.viewportCulling = options.viewportCulling ?? true;
		this.viewportOverscan = options.viewportOverscan ?? 16;
		this.visuals = options.visuals;
		if (!Number.isSafeInteger(this.maxVisibleEdges) || this.maxVisibleEdges < 1) {
			throw new Error("Maximum visible edges must be a positive integer.");
		}
		if (!Number.isSafeInteger(this.maxVisibleNodes) || this.maxVisibleNodes < 1) {
			throw new Error("Maximum visible nodes must be a positive integer.");
		}
		if (!Number.isFinite(this.viewportOverscan) || this.viewportOverscan < 0) {
			throw new Error("Viewport overscan must be a non-negative finite number.");
		}
		this.theme = resolveGraphraumTheme(options.theme);
		this.renderer = new WebGLRenderer({ antialias: options.antialias ?? false, alpha: true });
		this.applyBackground();
		const context = this.renderer.getContext();
		if (typeof WebGL2RenderingContext !== "undefined" && context instanceof WebGL2RenderingContext) {
			const extension = context.getExtension("EXT_disjoint_timer_query_webgl2");
			if (extension) this.gpuTimer = { context, extension, pending: [] };
		}
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.maxPixelRatio ?? 2));
		this.renderer.domElement.style.display = "block";
		this.renderer.domElement.style.height = "100%";
		this.renderer.domElement.style.width = "100%";
		this.container.append(this.renderer.domElement);
		this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
		this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
		for (const type of FLIGHT_CANCEL_EVENTS) this.renderer.domElement.addEventListener(type, this.cancelFlight);

		this.camera = this.createCamera();
		this.controls = this.createControls();
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(container);
		this.resize();
	}

	/** Replaces the whole graph. Fits the camera unless `options.fit` is `false`. */
	setData(data: GraphraumData<NodeAttributes, EdgeAttributes>, options: GraphraumSetDataOptions = {}) {
		const { fit = true } = options;
		if (typeof fit !== "boolean") throw new Error("setData option fit must be a boolean.");
		this.replaceData(data, fit);
	}

	/** Merge a topology patch without fitting or resetting the current camera. */
	applyDataPatch(patch: GraphraumDataPatch<NodeAttributes, EdgeAttributes>) {
		const addedNodeIds = new Set((patch.addedNodes ?? []).map((node) => node.id));
		const addedEdgeIds = new Set((patch.addedEdges ?? []).map((edge) => edge.id));
		if (addedNodeIds.size !== (patch.addedNodes ?? []).length) throw new Error("Duplicate added node ID.");
		if (addedEdgeIds.size !== (patch.addedEdges ?? []).length) throw new Error("Duplicate added edge ID.");
		if (isAppendOnlyDataPatch(patch) && this.canAppendDataPatch(patch)) {
			this.appendDataPatch(patch);
			return;
		}
		const merged = mergeDataPatch(this.data.nodes, this.data.edges, patch);
		if (this.canMutateDataInPlace(merged)) {
			this.mutateDataInPlace(merged);
			return;
		}
		this.replaceData(merged, false);
	}

	private canAppendDataPatch(patch: GraphraumDataPatch<NodeAttributes, EdgeAttributes>) {
		if (!this.nodeMesh || !this.nodePickMesh || !this.edgeMesh) return false;
		const nodeIds = new Set(this.data.nodes.map((node) => node.id));
		if ((patch.addedNodes ?? []).some((node) => nodeIds.has(node.id))) return false;
		const edgeIds = new Set(this.data.edges.map((edge) => edge.id));
		if ((patch.addedEdges ?? []).some((edge) => edgeIds.has(edge.id))) return false;
		const allNodeIds = new Set([...nodeIds, ...(patch.addedNodes ?? []).map((node) => node.id)]);
		return (
			(patch.addedNodes?.length ?? 0) + this.data.nodes.length <= this.nodeCapacity &&
			(patch.addedEdges?.length ?? 0) + this.data.edges.length <= this.edgeCapacity &&
			(patch.addedEdges ?? []).every((edge) => allNodeIds.has(edge.source) && allNodeIds.has(edge.target))
		);
	}

	private canMutateDataInPlace(merged: MergedGraphData<NodeAttributes, EdgeAttributes>) {
		if (!this.nodeMesh || !this.nodePickMesh || !this.edgeMesh) return false;
		return dataPatchFitsCapacity(merged, { edges: this.edgeCapacity, nodes: this.nodeCapacity });
	}

	private mutateDataInPlace(merged: MergedGraphData<NodeAttributes, EdgeAttributes>) {
		const compiled = compileGraph(merged, this.visuals);
		this.data = {
			edges: merged.edges.map((edge, index) => ({ ...edge, ...compiled.edgeVisuals[index] })),
			nodes: merged.nodes.map((node, index) => ({
				...node,
				...compiled.nodeVisuals[index],
				position: { ...node.position },
			})),
		};
		this.nodeIds = compiled.nodeIds;
		this.hasGlowNodes = this.data.nodes.some(hasNodeGlow);
		this.nodeIndices = new Map(compiled.nodeIndices);
		this.edgeNodeIndices = compiled.edgeNodeIndices;
		this.canonicalEdgePositions = compiled.edgePositions;
		this.incidentEdgeIndices = compiled.incidentEdgeIndices;
		this.nodePresentations = new Map(compiled.nodePresentations);
		this.edgePresentations = new Map(compiled.edgePresentations);
		this.spatialGrid2d = new SpatialGrid2D();
		for (const [index, node] of this.data.nodes.entries()) this.spatialGrid2d.set(index, node);
		const liveNodeIds = new Set(this.nodeIds);
		this.selectedNodeIds = new Set([...this.selectedNodeIds].filter((id) => liveNodeIds.has(id)));
		this.hoveredNodeIds = new Set([...this.hoveredNodeIds].filter((id) => liveNodeIds.has(id)));
		this.focusedNodeIds = new Set([...this.focusedNodeIds].filter((id) => liveNodeIds.has(id)));
		this.dimmedNodeIds = new Set([...this.dimmedNodeIds].filter((id) => liveNodeIds.has(id)));
		this.pruneEdgeStates();
		this.materializeViewport();
		this.requestRender();
	}

	private appendDataPatch(patch: GraphraumDataPatch<NodeAttributes, EdgeAttributes>) {
		const addedNodes = patch.addedNodes ?? [];
		const addedEdges = patch.addedEdges ?? [];
		if (addedNodes.length === 0 && addedEdges.length === 0) return;
		const nodeById = new Map(this.data.nodes.map((node) => [node.id, node]));
		for (const node of addedNodes) nodeById.set(node.id, node);
		const edgeEndpointNodes = addedEdges.flatMap((edge) => {
			const source = nodeById.get(edge.source);
			const target = nodeById.get(edge.target);
			return source && target ? [source, target] : [];
		});
		const patchNodes = [...addedNodes, ...edgeEndpointNodes].filter(
			(node, index, all) => all.findIndex((candidate) => candidate.id === node.id) === index,
		);
		const compiled = compileGraph({ nodes: patchNodes, edges: addedEdges }, this.visuals);
		const nodeVisuals = new Map(patchNodes.map((node, index) => [node.id, compiled.nodeVisuals[index]]));
		const nextNodes = [...this.data.nodes, ...addedNodes.map((node) => ({ ...node, ...nodeVisuals.get(node.id) }))];
		const nextNodeIndices = new Map(this.nodeIndices);
		for (const [index, node] of nextNodes.entries()) nextNodeIndices.set(node.id, index);
		const nextEdges = [
			...this.data.edges,
			...addedEdges.map((edge, index) => ({ ...edge, ...compiled.edgeVisuals[index] })),
		];
		const nextEdgeIndices = new Uint32Array(nextEdges.length * 2);
		nextEdgeIndices.set(this.edgeNodeIndices);
		const nextEdgePositions = new Float32Array(nextEdges.length * 6);
		nextEdgePositions.set(this.canonicalEdgePositions);
		const nextIncidentEdges = this.incidentEdgeIndices.map((indices) => [...indices]);
		for (const [index, edge] of nextEdges.entries()) {
			const source = nextNodeIndices.get(edge.source);
			const target = nextNodeIndices.get(edge.target);
			if (source === undefined || target === undefined) continue;
			nextEdgeIndices[index * 2] = source;
			nextEdgeIndices[index * 2 + 1] = target;
			if (!nextIncidentEdges[source]) nextIncidentEdges[source] = [];
			if (!nextIncidentEdges[target]) nextIncidentEdges[target] = [];
			if (index >= this.data.edges.length) {
				nextIncidentEdges[source]?.push(index);
				nextIncidentEdges[target]?.push(index);
				const sourceNode = nextNodes[source];
				const targetNode = nextNodes[target];
				if (sourceNode && targetNode) {
					nextEdgePositions.set(
						[
							sourceNode.position.x,
							sourceNode.position.y,
							sourceNode.position.z ?? 0,
							targetNode.position.x,
							targetNode.position.y,
							targetNode.position.z ?? 0,
						],
						index * 6,
					);
				}
			}
		}
		this.data = { nodes: nextNodes, edges: nextEdges };
		this.nodeIds = nextNodes.map((node) => node.id);
		this.hasGlowNodes = nextNodes.some(hasNodeGlow);
		this.nodeIndices = nextNodeIndices;
		this.edgeNodeIndices = nextEdgeIndices;
		this.canonicalEdgePositions = nextEdgePositions;
		this.incidentEdgeIndices = nextIncidentEdges;
		for (const node of addedNodes) {
			const index = nextNodeIndices.get(node.id);
			const nextNode = index === undefined ? undefined : this.data.nodes[index];
			if (index !== undefined && nextNode) this.spatialGrid2d.set(index, nextNode);
		}
		for (const [id, presentation] of compiled.nodePresentations) this.nodePresentations.set(id, presentation);
		for (const [id, presentation] of compiled.edgePresentations) this.edgePresentations.set(id, presentation);
		this.materializeViewport();
		this.requestRender();
	}

	private replaceData(data: GraphraumData<NodeAttributes, EdgeAttributes>, fitView: boolean) {
		const compiled = compileGraph(data, this.visuals);
		this.disposeGraphObjects();
		this.data = {
			edges: data.edges.map((edge, index) => ({ ...edge, ...compiled.edgeVisuals[index] })),
			nodes: data.nodes.map((node, index) => ({
				...node,
				...compiled.nodeVisuals[index],
				position: { ...node.position },
			})),
		};
		this.nodeIds = compiled.nodeIds;
		this.hasGlowNodes = this.data.nodes.some(hasNodeGlow);
		this.nodeIndices = new Map(compiled.nodeIndices);
		this.edgeNodeIndices = compiled.edgeNodeIndices;
		this.canonicalEdgePositions = compiled.edgePositions;
		this.incidentEdgeIndices = compiled.incidentEdgeIndices;
		this.nodePresentations = new Map(compiled.nodePresentations);
		this.edgePresentations = new Map(compiled.edgePresentations);
		this.spatialGrid2d = new SpatialGrid2D();
		for (const [index, node] of this.data.nodes.entries()) this.spatialGrid2d.set(index, node);
		this.pruneEdgeStates();

		this.nodeCapacity = Math.min(this.maxVisibleNodes, nextCapacity(data.nodes.length));
		const nodeCapacity = this.nodeCapacity;
		const nodeGeometry = createNodeGeometry(nodeCapacity);
		const nodeMaterial = createNodeMaterial(this.mode === "3d");
		const nodeMesh = new InstancedMesh(nodeGeometry, nodeMaterial, nodeCapacity);
		allocateNodeInstanceColors(nodeMesh, nodeCapacity);
		nodeMesh.renderOrder = NODE_RENDER_ORDER;
		this.nodeMesh = nodeMesh;
		this.scene.add(nodeMesh);

		const nodePickMesh = new InstancedMesh(new SphereGeometry(1, 8, 6), new MeshBasicMaterial(), nodeCapacity);
		this.nodePickMesh = nodePickMesh;

		const capacities = edgeInstanceCapacities(data.edges.length, this.maxVisibleEdges);
		this.edgeCapacity = capacities.edgeCapacity;
		this.edgeSegmentCapacity = capacities.segmentCapacity;
		this.markerCapacity = capacities.markerCapacity;
		this.edgeInstanceCapacity = capacities.edgeInstanceCapacity;
		const edgeGeometry = createEdgeGeometry(this.edgeInstanceCapacity);
		const edgeMaterial = createEdgeMaterial();
		const edgeMesh = new InstancedMesh(edgeGeometry, edgeMaterial, this.edgeInstanceCapacity);
		edgeMesh.frustumCulled = false;
		edgeMesh.renderOrder = EDGE_RENDER_ORDER;
		this.edgeMesh = edgeMesh;
		this.scene.add(edgeMesh);

		if (fitView) this.fitView();
		else {
			this.materializeViewport();
			this.requestRender();
		}
	}

	updateNodes(updates: readonly GraphraumNodeUpdate[]) {
		if (updates.length === 0) return;
		const objects = this.getGraphObjects("update nodes");
		const prepared = prepareNodeUpdates(this.data.nodes, this.nodeIndices, updates);
		this.applyPreparedNodeUpdates(prepared, objects);
	}

	/** Applies a transferable XYZ layout batch. Call repeatedly as a worker produces progressive positions. */
	applyLayout(layout: GraphraumLayoutPositions) {
		const prepared = prepareLayoutPositions(this.data.nodes, this.nodeIndices, layout);
		if (prepared.length === 0) return;
		const objects = this.getGraphObjects("apply a layout");
		this.applyPreparedNodeUpdates(prepared, objects);
	}

	private getGraphObjects(action: string): GraphraumGraphObjects {
		if (!this.nodeMesh || !this.nodePickMesh || !this.edgeMesh) {
			throw new Error(`Cannot ${action} before graph data is set`);
		}
		return { edgeMesh: this.edgeMesh, nodeMesh: this.nodeMesh, nodePickMesh: this.nodePickMesh };
	}

	private applyPreparedNodeUpdates(
		prepared: readonly PreparedNodeUpdate<NodeAttributes>[],
		{ nodeMesh, nodePickMesh }: GraphraumGraphObjects,
	) {
		const nodes = [...this.data.nodes];
		const matrix = new Matrix4();
		const nodeShape = nodeMesh.geometry.getAttribute("instanceShape") as InstancedBufferAttribute;
		const nodeStrokeWidth = nodeMesh.geometry.getAttribute("instanceStrokeWidth") as InstancedBufferAttribute;
		const nodeStrokeColor = nodeMesh.geometry.getAttribute("instanceStrokeColor") as InstancedBufferAttribute;
		const viewportBounds = this.getViewportBounds2d();
		let visibilityChanged = false;
		// Edge segments are patched in place when visibility is stable; otherwise materializeViewport
		// repacks the visible set (visibility, LOD, or segment-count changes).
		let edgeEndpointsChanged = false;
		const changedEdgeIndices = new Set<number>();

		for (const update of prepared) {
			nodes[update.index] = update.next;
			if (update.positionChanged || update.sizeChanged) {
				const wasVisible = this.visibleNodeSlots.has(update.index);
				this.spatialGrid2d.set(update.index, update.next);
				visibilityChanged ||= wasVisible !== this.isNodeVisible2d(update.next, viewportBounds);
			}
			const nodeSlot = this.visibleNodeSlots.get(update.index);
			if (update.positionChanged || update.sizeChanged) {
				if (nodeSlot !== undefined) {
					const { height, width } = resolveNodeAxes({
						height: update.next.height,
						nodeId: update.next.id,
						size: update.next.size,
						width: update.next.width,
					});
					const maxAxis = Math.max(width, height);
					matrix.makeScale(width, height, maxAxis);
					matrix.setPosition(update.next.position.x, update.next.position.y, update.next.position.z ?? 0);
					nodeMesh.setMatrixAt(nodeSlot, matrix);
					nodeMesh.instanceMatrix.addUpdateRange(nodeSlot * 16, 16);
					const pickScale = maxAxis * Math.SQRT2;
					matrix.makeScale(pickScale, pickScale, pickScale);
					matrix.setPosition(update.next.position.x, update.next.position.y, update.next.position.z ?? 0);
					nodePickMesh.setMatrixAt(nodeSlot, matrix);
					nodePickMesh.instanceMatrix.addUpdateRange(nodeSlot * 16, 16);
				}
			}
			if (update.colorChanged && nodeSlot !== undefined) {
				nodeMesh.setColorAt(nodeSlot, this.getNodeColor(update.next));
				nodeMesh.instanceColor?.addUpdateRange(nodeSlot * 3, 3);
			}
			if (update.shapeChanged && nodeSlot !== undefined) {
				setNodeShapeAt(nodeShape, nodeSlot, update.next.shape);
				nodeShape.addUpdateRange(nodeSlot, 1);
			}
			if (update.strokeChanged && nodeSlot !== undefined) {
				setNodeStrokeAt(nodeStrokeWidth, nodeStrokeColor, nodeSlot, resolveNodeStroke(update.next, this.theme));
				nodeStrokeWidth.addUpdateRange(nodeSlot, 1);
				nodeStrokeColor.addUpdateRange(nodeSlot * 3, 3);
			}
			if (update.positionChanged) {
				const incidentEdges = this.incidentEdgeIndices[update.index] ?? [];
				if (incidentEdges.length > 0) edgeEndpointsChanged = true;
				for (const edgeIndex of incidentEdges) {
					changedEdgeIndices.add(edgeIndex);
					const sourceIndex = this.edgeNodeIndices[edgeIndex * 2];
					const canonicalOffset = edgeIndex * 6 + (sourceIndex === update.index ? 0 : 3);
					this.canonicalEdgePositions.set(
						[update.next.position.x, update.next.position.y, update.next.position.z ?? 0],
						canonicalOffset,
					);
				}
			}
		}
		if (this.densityLodActive && prepared.some((update) => update.positionChanged || update.sizeChanged)) {
			visibilityChanged = true;
		}
		const glowChanged = prepared.some((update) => update.glowChanged);
		// Before any early return: materializeViewport below reads it through syncGlow.
		if (glowChanged) this.hasGlowNodes = nodes.some(hasNodeGlow);

		this.data = { ...this.data, nodes };
		if (visibilityChanged) {
			this.materializeViewport();
			this.requestRender();
			return;
		}
		if (edgeEndpointsChanged) {
			const patched = this.patchVisibleEdgeEndpoints([...changedEdgeIndices]);
			if (!patched) this.materializeViewport();
		}
		if (prepared.some((update) => update.positionChanged || update.sizeChanged)) {
			nodeMesh.instanceMatrix.needsUpdate = true;
			nodePickMesh.instanceMatrix.needsUpdate = true;
		}
		if (prepared.some((update) => update.colorChanged) && nodeMesh.instanceColor) {
			nodeMesh.instanceColor.needsUpdate = true;
		}
		if (prepared.some((update) => update.shapeChanged)) nodeShape.needsUpdate = true;
		if (glowChanged) this.syncGlow();
		else if (prepared.some((update) => update.positionChanged || update.sizeChanged || update.colorChanged)) {
			this.glowLayer.rewrite(this.describeGlowNode);
		}
		if (prepared.some((update) => update.strokeChanged)) {
			nodeStrokeWidth.needsUpdate = true;
			nodeStrokeColor.needsUpdate = true;
		}
		this.requestRender();
	}

	/** Patches GPU edge instances for moved endpoints when the visible edge set is unchanged. */
	private patchVisibleEdgeEndpoints(changedEdgeIndices: readonly number[]): boolean {
		if (!this.edgeMesh || changedEdgeIndices.length === 0) return true;
		const worldPerPixel = this.worldUnitsPerPixel();
		const minHitSlop = Math.max(4 * worldPerPixel, this.theme.edgeWidth * worldPerPixel);
		const result = patchVisibleEdgeInstances(
			this.edgeMesh.geometry,
			{
				changedEdgeIndices,
				defaults: { color: this.theme.edge, opacity: this.theme.edgeOpacity, width: this.theme.edgeWidth },
				edgeNodeIndices: this.edgeNodeIndices,
				edgeStates: this.edgeStateStyling(),
				edgeVisuals: this.data.edges,
				endpointAttach: this.theme.endpointAttach,
				endpointPositions: this.canonicalEdgePositions,
				layouts: this.visibleEdgeLayouts,
				minHitSlop,
				mode: this.mode,
				nodeOutlines: this.data.nodes.map((node) => ({
					height: node.height,
					shape: node.shape,
					size: node.size,
					strokeWidth: node.strokeWidth,
					width: node.width,
				})),
				tier: this.lastEdgeLodTier,
				worldPerPixel,
			},
			this.pickableEdgeSegments,
		);
		if (!result.ok) return false;
		this.pickableEdgeSegments = result.pickableSegments;
		return true;
	}

	setSelection(nodeIds: Iterable<string>) {
		this.setNodeState("selected", nodeIds);
	}

	/**
	 * Highlights edges without changing node selection or source graph data. Unknown IDs are ignored.
	 * Only the instance colors of edges whose selection changed are rewritten and uploaded.
	 */
	setEdgeSelection(edgeIds: Iterable<string>) {
		const next = this.knownEdgeIds(edgeIds);
		const changed = changedIds(this.selectedEdgeIds, next);
		this.selectedEdgeIds = next;
		this.repaintEdgeStates(changed);
	}

	/**
	 * Applies an application-owned edge state without changing source graph data. `dimmed` uses
	 * `theme.dimmedEdge` / `theme.dimmedEdgeOpacity`; selected edges stay selected. Unknown IDs are ignored.
	 */
	setEdgeState(state: GraphraumEdgeState, edgeIds: Iterable<string>) {
		if (state !== "dimmed") throw new Error(`Unknown edge state "${String(state)}". Use "dimmed".`);
		const next = this.knownEdgeIds(edgeIds);
		const changed = changedIds(this.dimmedEdgeIds, next);
		this.dimmedEdgeIds = next;
		this.repaintEdgeStates(changed);
	}

	private knownEdgeIds(edgeIds: Iterable<string>) {
		const indices = this.edgeIndicesById();
		return new Set([...edgeIds].filter((id) => indices.has(id)));
	}

	/**
	 * Visible slots, LOD tier, and geometry only change through materialize or endpoint patches,
	 * which keep `visibleEdgeLayouts` current, so a state change repaints in place. If a layout no
	 * longer fits the drawn instances, that invariant broke: fall back to a full materialize.
	 */
	private repaintEdgeStates(changedEdgeIds: readonly string[]) {
		if (!this.edgeMesh || changedEdgeIds.length === 0) return;
		const indices = this.edgeIndicesById();
		const result = patchVisibleEdgePaint(this.edgeMesh.geometry, {
			changedEdgeIndices: changedEdgeIds.flatMap((id) => indices.get(id) ?? []),
			defaults: { color: this.theme.edge, opacity: this.theme.edgeOpacity },
			edgeStates: this.edgeStateStyling(),
			edgeVisuals: this.data.edges,
			instanceCount: this.edgeMesh.count,
			layouts: this.visibleEdgeLayouts,
			tier: this.lastEdgeLodTier,
		});
		if (!result.ok) this.materializeViewport();
		this.requestRender();
	}

	private edgeStateStyling(): EdgeStateStyling {
		return {
			dimmedColor: this.theme.dimmedEdge,
			dimmedOpacity: this.theme.dimmedEdgeOpacity,
			selectedColor: this.theme.selectedEdge,
			stateOf: (edgeIndex) => {
				const id = this.data.edges[edgeIndex]?.id;
				if (id === undefined) return null;
				if (this.selectedEdgeIds.has(id)) return "selected";
				return this.dimmedEdgeIds.has(id) ? "dimmed" : null;
			},
		};
	}

	/** Edge ID to compiled index, rebuilt only when the edge list is replaced. */
	private edgeIndicesById(): ReadonlyMap<string, number> {
		if (this.edgeIndexCache.edges !== this.data.edges) {
			this.edgeIndexCache = {
				edges: this.data.edges,
				indices: new Map(this.data.edges.map((edge, index) => [edge.id, index])),
			};
		}
		return this.edgeIndexCache.indices;
	}

	/** Drops edge states whose edges left the graph. */
	private pruneEdgeStates() {
		const indices = this.edgeIndicesById();
		this.selectedEdgeIds = new Set([...this.selectedEdgeIds].filter((id) => indices.has(id)));
		this.dimmedEdgeIds = new Set([...this.dimmedEdgeIds].filter((id) => indices.has(id)));
	}

	/** Applies an application-owned visual state without changing source graph data. */
	setNodeState(state: GraphraumNodeState, nodeIds: Iterable<string>) {
		const nextSelection = new Set(nodeIds);
		const currentSelection = this.getNodeStateIds(state);
		const changedNodeIds = new Set(
			[...currentSelection, ...nextSelection].filter(
				(nodeId) => currentSelection.has(nodeId) !== nextSelection.has(nodeId),
			),
		);
		if (changedNodeIds.size === 0) return;
		this.setNodeStateIds(state, nextSelection);
		this.applySelectionColors(changedNodeIds);
		this.requestRender();
		if (state === "selected" || state === "hovered") this.notifyFocusChange();
	}

	/** One-hop neighbor node ids via incident edges (undirected adjacency). */
	getNeighborIds(nodeId: string): string[] {
		const index = this.nodeIndices.get(nodeId);
		if (index === undefined) return [];
		const neighbors = new Set<string>();
		for (const edgeIndex of this.incidentEdgeIndices[index] ?? []) {
			const edge = this.data.edges[edgeIndex];
			if (!edge) continue;
			if (edge.source !== nodeId) neighbors.add(edge.source);
			if (edge.target !== nodeId) neighbors.add(edge.target);
		}
		return [...neighbors];
	}

	getSelectedNodeIds(): readonly string[] {
		return [...this.selectedNodeIds];
	}

	getHoveredNodeIds(): readonly string[] {
		return [...this.hoveredNodeIds];
	}

	/** Schedules one render on the next animation frame. Repeated calls in one frame are coalesced. */
	render() {
		this.requestRender();
	}

	setMode(mode: GraphraumMode) {
		if (mode === this.mode) return;
		this.cancelFlight();
		this.stopAutoOrbit();
		this.mode = mode;
		this.controls.removeEventListener("change", this.handleViewChange);
		this.controls.dispose();
		this.camera = this.createCamera();
		this.controls = this.createControls();
		if (this.nodeMesh && !Array.isArray(this.nodeMesh.material)) {
			this.nodeMesh.material.depthTest = mode === "3d";
			this.nodeMesh.material.depthWrite = mode === "3d";
			this.nodeMesh.material.needsUpdate = true;
		}
		this.fitView();
	}

	getMode() {
		return this.mode;
	}

	/**
	 * Slowly orbits the 3D camera around its target until called with `false`. The orbit pauses while
	 * the camera controls handle a drag, pinch or wheel step and resumes after `resumeAfterMs` of idle;
	 * it also stops while the document is hidden or the canvas is off screen. While it is active a
	 * frame loop renders every frame (no viewport rematerialization), so check `prefers-reduced-motion`
	 * before enabling it. Throws in 2D mode; `setMode("2d")` turns it off. Does nothing after `destroy()`.
	 */
	setAutoOrbit(options: GraphraumAutoOrbitOptions | false) {
		if (options === false || this.destroyed) {
			this.stopAutoOrbit();
			return;
		}
		if (this.mode !== "3d") {
			throw new Error('Auto-orbit requires 3D mode. Call setMode("3d") before setAutoOrbit(options).');
		}
		const { resumeAfterMs, speed } = resolveAutoOrbitOptions(options);
		this.controls.autoRotateSpeed = autoRotateSpeedFor(speed);
		if (this.autoOrbit && this.autoOrbit.status !== "off") this.autoOrbit.setResumeAfterMs(resumeAfterMs);
		else this.autoOrbit = new AutoOrbitLoop(this.renderer.domElement, this.controls, resumeAfterMs, this.stepAutoOrbit);
	}

	getNodePresentation(nodeId: string): CompiledGraphraumPresentation | null {
		return this.nodePresentations.get(nodeId) ?? null;
	}

	/** Returns canvas-relative screen coordinates for a node, or null when the node does not exist. */
	getNodeScreenPosition(nodeId: string): GraphraumScreenPosition | null {
		const index = this.nodeIndices.get(nodeId);
		const node = index === undefined ? undefined : this.data.nodes[index];
		if (!node) return null;
		const projected = new Vector3(node.position.x, node.position.y, node.position.z ?? 0).project(this.camera);
		const width = this.renderer.domElement.clientWidth;
		const height = this.renderer.domElement.clientHeight;
		return {
			visible:
				projected.x >= -1 &&
				projected.x <= 1 &&
				projected.y >= -1 &&
				projected.y <= 1 &&
				projected.z >= -1 &&
				projected.z <= 1,
			x: ((projected.x + 1) * width) / 2,
			y: ((1 - projected.y) * height) / 2,
		};
	}

	/**
	 * Candidates for a budgeted DOM label layer. Importance is incident edge degree, with a boost
	 * for selected nodes so selection stays labeled. Visibility comes from screen projection.
	 */
	getLabelCandidates(): GraphraumLabelCandidate[] {
		return this.data.nodes.map((node, index) => {
			const degree = this.incidentEdgeIndices[index]?.length ?? 0;
			return {
				id: node.id,
				importance: degree + (this.selectedNodeIds.has(node.id) ? SELECTED_LABEL_IMPORTANCE_BOOST : 0),
				visible: this.getNodeScreenPosition(node.id)?.visible ?? false,
			};
		});
	}

	/** Converts client coordinates to graph world coordinates on the z=0 plane. */
	screenToWorld(clientX: number, clientY: number): { x: number; y: number; z: number } | null {
		const bounds = this.renderer.domElement.getBoundingClientRect();
		if (bounds.width === 0 || bounds.height === 0) return null;
		const worldX = ((clientX - bounds.left) / bounds.width) * 2 - 1;
		const worldY = -((clientY - bounds.top) / bounds.height) * 2 + 1;
		this.pointer.set(worldX, worldY);
		if (this.camera instanceof OrthographicCamera) {
			const world = new Vector3(this.pointer.x, this.pointer.y, 0).unproject(this.camera);
			return { x: world.x, y: world.y, z: world.z };
		}
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const plane = new Plane(new Vector3(0, 0, 1), 0);
		const world = this.raycaster.ray.intersectPlane(plane, new Vector3());
		if (!world) return null;
		return { x: world.x, y: world.y, z: world.z };
	}

	/** Creates a bounded DOM layer for labels, a toolbar, and optional rich HTML focus cards. */
	createOverlay(options: GraphraumOverlayOptions = {}) {
		return new GraphraumOverlay(this, this.container, options);
	}

	/** Subscribes to camera and viewport changes. Returns an unsubscribe function. */
	onViewChange(listener: () => void) {
		this.viewListeners.add(listener);
		listener();
		return () => this.viewListeners.delete(listener);
	}

	/** Subscribes to selection and hover changes that affect overlay focus chrome. */
	onFocusChange(listener: () => void) {
		this.focusListeners.add(listener);
		listener();
		return () => this.focusListeners.delete(listener);
	}

	private notifyFocusChange() {
		for (const listener of this.focusListeners) listener();
	}

	private handlePointerMove = (event: PointerEvent) => {
		const nodeId = this.pickNode(event.clientX, event.clientY);
		if (nodeId === this.lastHoveredNodeId) return;
		this.lastHoveredNodeId = nodeId;
		this.setNodeState("hovered", nodeId ? [nodeId] : []);
	};

	private handlePointerLeave = () => {
		if (this.lastHoveredNodeId === null && this.hoveredNodeIds.size === 0) return;
		this.lastHoveredNodeId = null;
		this.setNodeState("hovered", []);
	};

	getEdgePresentation(edgeId: string): CompiledGraphraumPresentation | null {
		return this.edgePresentations.get(edgeId) ?? null;
	}

	getDiagnostics(): GraphraumDiagnostics {
		return {
			aggregatedNodeClusters: this.densityLodActive ? this.visibleNodeCount : 0,
			autoOrbit: this.autoOrbit?.status ?? "off",
			cpuFrameMilliseconds: this.cpuFrameMilliseconds,
			gpuFrameMilliseconds: this.gpuFrameMilliseconds,
			gpuDrawCalls: this.renderer.info.render.calls,
			gpuGeometries: this.renderer.info.memory.geometries,
			gpuTextures: this.renderer.info.memory.textures,
			lodLevel: resolveLodLevel(this.densityLodActive, this.visibleEdgeCandidateCount, this.visibleEdgeCount),
			pickingStrategy: this.mode === "2d" ? "spatial-grid-2d" : "raycaster-3d",
			dimmedEdges: this.dimmedEdgeIds.size,
			selectedEdges: this.selectedEdgeIds.size,
			selectedNodes: this.selectedNodeIds.size,
			totalEdges: this.data.edges.length,
			totalNodes: this.data.nodes.length,
			visibleEdgeCandidates: this.visibleEdgeCandidateCount,
			visibleEdgeMarkers: this.visibleEdgeMarkerCount,
			visibleEdgeSegments: this.visibleEdgeSegmentCount,
			visibleEdges: this.visibleEdgeCount,
			visibleGlowNodes: this.glowLayer.count,
			visibleNodes: this.visibleNodeCount,
			visibleNodeCandidates: this.visibleNodeCandidateCount,
		};
	}

	/** Picks a node under the pointer. Prefer `pickHit` when edges must be selectable too. */
	pick(clientX: number, clientY: number): string | null {
		const hit = this.pickHit(clientX, clientY);
		return hit?.kind === "node" ? hit.id : null;
	}

	/**
	 * Picks the top-most graph element under the pointer. Nodes win over edges when both hit.
	 * 2D uses the spatial grid for nodes and world-space segment distance for edges; 3D uses
	 * the node pick mesh then the edge instance mesh.
	 */
	pickHit(clientX: number, clientY: number): GraphraumPickHit | null {
		const nodeId = this.pickNode(clientX, clientY);
		if (nodeId) return { kind: "node", id: nodeId };
		const edgeId = this.pickEdge(clientX, clientY);
		return edgeId ? { kind: "edge", id: edgeId } : null;
	}

	/** Frames every node, or only `nodeIds`; unknown ids are ignored and no match frames all nodes. Cancels a running `flyTo`. */
	fitView(options?: { nodeIds?: readonly string[] }) {
		this.cancelFlight();
		if (!this.nodeMesh || this.data.nodes.length === 0) {
			this.requestRender();
			return;
		}
		const subset = this.nodesWithIds(options?.nodeIds);
		const nodes = subset.length > 0 ? subset : this.data.nodes;

		const width = Math.max(this.container.clientWidth, 1);
		const height = Math.max(this.container.clientHeight, 1);
		if (this.camera instanceof OrthographicCamera) {
			const aspect = width / height;
			const fit = orthographicFit(aspect, nodes);
			setOrthographicFrustum(this.camera, aspect, fit.visibleHeight);
			this.camera.position.set(fit.center.x, fit.center.y, fit.cameraZ);
			this.camera.lookAt(fit.center);
			this.controls.target.copy(fit.center);
		} else {
			const fit = this.perspectiveFit(this.camera, width, height, nodes);
			this.camera.near = fit.near;
			this.camera.far = fit.far;
			this.camera.position.set(fit.target.x, fit.target.y, fit.cameraZ);
			this.controls.target.set(fit.target.x, fit.target.y, fit.target.z);
			this.camera.lookAt(this.controls.target);
		}

		this.camera.updateProjectionMatrix();
		this.controls.update();
		this.materializeViewport();
		this.requestRender();
	}

	/**
	 * Animates the camera to frame `nodeIds` as `fitView({ nodeIds })` would, with an ease-in-out
	 * over `durationMs`. In 3D the camera and the orbit target move together and keep the current
	 * view direction, so a running auto-orbit carries on around the new target, at the fitted
	 * distance times `distanceScale`. In 2D it pans and zooms. Resolves `true` on arrival and
	 * `false` when cancelled by canvas pointer, wheel or key input, another `flyTo`, `fitView`,
	 * `setData`, `setMode`, a 2D resize or `destroy()`. Unknown IDs are ignored; when none match,
	 * or after `destroy()`, it resolves `false` without moving. With `prefers-reduced-motion:
	 * reduce` or a zero duration it jumps. Throws for an invalid duration or distance scale.
	 */
	flyTo(options: GraphraumFlyToOptions): Promise<boolean> {
		const { distanceScale, durationMs } = resolveFlyToOptions(options);
		this.cancelFlight();
		if (this.destroyed || !this.nodeMesh) return Promise.resolve(false);
		const nodes = this.nodesWithIds(options.nodeIds);
		if (nodes.length === 0) return Promise.resolve(false);
		const width = Math.max(this.container.clientWidth, 1);
		const height = Math.max(this.container.clientHeight, 1);
		const flight =
			this.camera instanceof OrthographicCamera
				? this.planOrthographicFlight(this.camera, width / height, nodes, distanceScale)
				: this.planPerspectiveFlight(this.camera, width, height, nodes, distanceScale);
		if (durationMs === 0 || prefersReducedMotion()) {
			flight.step(1);
			flight.arrive();
			this.requestRender();
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			this.flight = { ...flight, durationMs, resolve, startMs: null };
			this.requestRender();
		});
	}

	/**
	 * The camera pose as plain JSON. 2D reports the centre and the world height the canvas shows; 3D
	 * reports the camera position and the point it orbits. Pass it to `setCameraState()` to return
	 * to the same view, for example after reloading a saved one.
	 */
	getCameraState(): GraphraumCameraState {
		const camera = this.camera;
		if (camera instanceof OrthographicCamera) {
			return {
				center: { x: camera.position.x, y: camera.position.y },
				mode: "2d",
				visibleHeight: (camera.top - camera.bottom) / camera.zoom,
			};
		}
		const { target } = this.controls;
		return {
			mode: "3d",
			position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
			target: { x: target.x, y: target.y, z: target.z },
		};
	}

	/**
	 * Puts the camera on a pose from `getCameraState()` at once, without fitting or animating, and
	 * cancels a running `flyTo`. Throws for a state of the other mode (switch with `setMode()` first)
	 * or with a non-finite number. 2D keeps the saved height and takes the width from the canvas, so a
	 * view saved on one canvas size fits another. 3D derives the clip planes from the pose so the whole
	 * graph stays in view. Apply it after the canvas has its size: a 2D resize to a new size refits.
	 */
	setCameraState(state: GraphraumCameraState) {
		const next = validateCameraState(state, this.mode);
		this.cancelFlight();
		const camera = this.camera;
		const width = Math.max(this.container.clientWidth, 1);
		const height = Math.max(this.container.clientHeight, 1);
		if (next.mode === "2d" && camera instanceof OrthographicCamera) {
			setOrthographicFrustum(camera, width / height, next.visibleHeight);
			camera.position.set(next.center.x, next.center.y, camera.position.z);
			this.controls.target.set(next.center.x, next.center.y, this.controls.target.z);
			camera.lookAt(this.controls.target);
			camera.updateProjectionMatrix();
			this.controls.update();
			this.materializeViewport();
		} else if (next.mode === "3d" && camera instanceof PerspectiveCamera) {
			const target = new Vector3(next.target.x, next.target.y, next.target.z);
			camera.position.set(next.position.x, next.position.y, next.position.z);
			this.controls.target.copy(target);
			camera.lookAt(target);
			applyPerspectiveContainerAspect(camera, width, height);
			const clip = perspectiveClipRange(camera.position.distanceTo(target), this.graphRadiusAround(target));
			camera.near = clip.near;
			camera.far = clip.far;
			camera.updateProjectionMatrix();
			this.controls.update();
		}
		this.requestRender();
	}

	/** Nodes whose id is in `nodeIds`, in graph order; every node when `nodeIds` is omitted. */
	private nodesWithIds(nodeIds: readonly string[] | undefined): GraphraumNodes<NodeAttributes> {
		if (!nodeIds) return this.data.nodes;
		const wanted = new Set(nodeIds);
		return this.data.nodes.filter((node) => wanted.has(node.id));
	}

	/** The closest front-view camera that frames `nodes` (issue #124); applies the container aspect. */
	private perspectiveFit(
		camera: PerspectiveCamera,
		width: number,
		height: number,
		nodes: GraphraumNodes<NodeAttributes>,
	): PerspectiveFit {
		applyPerspectiveContainerAspect(camera, width, height);
		return fitPerspective(
			{ aspect: camera.aspect, fill: PERSPECTIVE_FIT_FILL, fovDegrees: camera.fov },
			{
				count: nodes.length,
				read(index, out) {
					const node = nodes[index];
					const axes = resolveNodeAxes({ height: node.height, nodeId: node.id, size: node.size, width: node.width });
					out.x = node.position.x;
					out.y = node.position.y;
					out.z = node.position.z ?? 0;
					const extent = Math.max(axes.width, axes.height);
					// A glowing node's halo is a square billboard of the halo radius; keep it on screen.
					const glow = node.glow ?? 0;
					const halo = glow > 0 ? glowHaloRadius(extent, glow) : 0;
					out.halfWidth = Math.max(axes.width, halo);
					out.halfHeight = Math.max(axes.height, halo);
				},
			},
		);
	}

	/**
	 * A 3D flight keeps the view direction it reads from the camera every frame, so an orbit step
	 * between frames turns the flight with it. The destination distance is the front-view fit
	 * distance; near and far span both ends while flying, and the far plane at arrival still holds
	 * the whole graph so the rest of it stays visible around the framed nodes.
	 */
	private planPerspectiveFlight(
		camera: PerspectiveCamera,
		width: number,
		height: number,
		nodes: GraphraumNodes<NodeAttributes>,
		distanceScale: number,
	): CameraFlight {
		const fit = this.perspectiveFit(camera, width, height, nodes);
		const fromTarget = this.controls.target.clone();
		const toTarget = new Vector3(fit.target.x, fit.target.y, fit.target.z);
		const fromDistance = Math.max(camera.position.distanceTo(fromTarget), Number.EPSILON);
		const toDistance = (fit.cameraZ - fit.target.z) * distanceScale;
		const near = fit.near * Math.min(distanceScale, 1);
		const far = Math.max(fit.far * distanceScale, (toDistance + this.graphRadiusAround(toTarget)) * 1.1);
		camera.near = Math.min(camera.near, near);
		camera.far = Math.max(camera.far, far);
		camera.updateProjectionMatrix();
		return {
			arrive: () => {
				camera.near = near;
				camera.far = far;
				camera.updateProjectionMatrix();
				this.materializeViewport();
			},
			step: (eased) => {
				const direction = this.flightDirection.subVectors(camera.position, this.controls.target);
				if (direction.lengthSq() === 0) direction.set(0, 0, 1);
				direction.normalize();
				this.controls.target.lerpVectors(fromTarget, toTarget, eased);
				camera.position
					.copy(this.controls.target)
					.addScaledVector(direction, interpolateScale(fromDistance, toDistance, eased));
				camera.lookAt(this.controls.target);
			},
		};
	}

	/**
	 * A 2D flight switches to the destination frustum up front with a zoom that keeps the current
	 * view, then pans and eases the zoom back to 1, so it lands exactly on the fitted frustum.
	 */
	private planOrthographicFlight(
		camera: OrthographicCamera,
		aspect: number,
		nodes: GraphraumNodes<NodeAttributes>,
		distanceScale: number,
	): CameraFlight {
		const fit = orthographicFit(aspect, nodes);
		const fromVisibleHeight = (camera.top - camera.bottom) / camera.zoom;
		const toVisibleHeight = fit.visibleHeight * distanceScale;
		setOrthographicFrustum(camera, aspect, toVisibleHeight);
		const fromZoom = toVisibleHeight / fromVisibleHeight;
		camera.zoom = fromZoom;
		camera.updateProjectionMatrix();
		const fromPosition = camera.position.clone();
		const toPosition = new Vector3(fit.center.x, fit.center.y, fit.cameraZ);
		const fromTarget = this.controls.target.clone();
		return {
			arrive: () => this.materializeViewport(),
			step: (eased) => {
				camera.zoom = interpolateScale(fromZoom, 1, eased);
				camera.position.lerpVectors(fromPosition, toPosition, eased);
				this.controls.target.lerpVectors(fromTarget, fit.center, eased);
				camera.updateProjectionMatrix();
			},
		};
	}

	/** Largest distance from `center` to any node's far edge. */
	private graphRadiusAround(center: Vector3): number {
		let radius = 0;
		for (const node of this.data.nodes) {
			const axes = resolveNodeAxes({ height: node.height, nodeId: node.id, size: node.size, width: node.width });
			const distance = Math.hypot(
				node.position.x - center.x,
				node.position.y - center.y,
				(node.position.z ?? 0) - center.z,
			);
			radius = Math.max(radius, distance + Math.max(axes.width, axes.height));
		}
		return radius;
	}

	/** Steps a running flight to the frame time; settles and resolves it at the end. */
	private advanceFlight(nowMs: number) {
		const flight = this.flight;
		if (!flight) return;
		flight.startMs ??= nowMs;
		const progress = flightProgress(nowMs - flight.startMs, flight.durationMs);
		try {
			flight.step(easeInOutCubic(progress));
			if (progress < 1) {
				// 2D culls to the viewport, so a moving 2D camera repacks; 3D instances do not depend on the camera.
				if (this.mode === "2d") this.materializeViewport();
				this.requestRender();
				return;
			}
			this.flight = null;
			flight.arrive();
		} catch (error) {
			this.cancelFlight();
			throw error;
		}
		flight.resolve(true);
	}

	private readonly cancelFlight = () => {
		const flight = this.flight;
		if (!flight) return;
		this.flight = null;
		flight.resolve(false);
	};

	setTheme(theme: Partial<GraphraumTheme> | GraphraumThemeName) {
		this.theme = typeof theme === "string" ? resolveGraphraumTheme(theme) : resolveGraphraumTheme(theme, this.theme);
		this.applyBackground();
		if (this.nodeMesh) this.materializeViewport();
		this.requestRender();
	}

	setBackground(background: GraphraumBackground) {
		this.setTheme({ background });
	}

	resize() {
		const width = Math.max(this.container.clientWidth, 1);
		const height = Math.max(this.container.clientHeight, 1);
		const sizeChanged = this.canvasWidth !== width || this.canvasHeight !== height;
		this.canvasWidth = width;
		this.canvasHeight = height;
		this.renderer.setSize(width, height, false);
		if (this.camera instanceof PerspectiveCamera) {
			applyPerspectiveContainerAspect(this.camera, width, height);
			this.camera.updateProjectionMatrix();
		} else if (this.camera instanceof OrthographicCamera && sizeChanged) {
			// Ortho frustum must track container aspect or the canvas stretches and the graph skews.
			// The same size again (the observer's first call, a manual `resize()`) leaves the view alone.
			this.fitView();
			return;
		}
		this.materializeViewport();
		this.requestRender();
	}

	destroy() {
		this.destroyed = true;
		this.cancelFlight();
		this.stopAutoOrbit();
		this.resizeObserver.disconnect();
		this.renderer.domElement.removeEventListener("pointermove", this.handlePointerMove);
		this.renderer.domElement.removeEventListener("pointerleave", this.handlePointerLeave);
		for (const type of FLIGHT_CANCEL_EVENTS) this.renderer.domElement.removeEventListener(type, this.cancelFlight);
		this.controls.removeEventListener("change", this.handleViewChange);
		this.controls.dispose();
		if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
		if (this.gpuTimer) {
			for (const query of this.gpuTimer.pending) this.gpuTimer.context.deleteQuery(query);
		}
		this.disposeBackgroundTexture();
		this.disposeGraphObjects();
		this.renderer.dispose();
		this.renderer.domElement.remove();
	}

	private readonly requestRender = () => {
		if (this.frameRequest !== null) return;
		this.frameRequest = requestAnimationFrame((nowMs) => {
			this.frameRequest = null;
			this.advanceFlight(nowMs);
			this.renderFrame();
		});
	};

	/** Renders a pending frame now instead of on the next animation frame. */
	private flushRender() {
		if (this.frameRequest === null) return;
		cancelAnimationFrame(this.frameRequest);
		this.frameRequest = null;
		this.renderFrame();
	}

	private renderFrame() {
		this.readGpuTimers();
		const timer = this.gpuTimer;
		const query = timer?.context.createQuery() ?? null;
		if (timer && query) timer.context.beginQuery(timer.extension.TIME_ELAPSED_EXT, query);
		const startedAt = performance.now();
		this.renderer.render(this.scene, this.camera);
		this.cpuFrameMilliseconds = performance.now() - startedAt;
		if (timer && query) {
			timer.context.endQuery(timer.extension.TIME_ELAPSED_EXT);
			timer.pending.push(query);
		}
		for (const listener of this.viewListeners) listener();
	}

	private stopAutoOrbit() {
		this.autoOrbit?.dispose();
		this.autoOrbit = null;
	}

	/**
	 * One orbit frame. `autoRotate` is on only for this `update(dt)` call: OrbitControls also calls
	 * `update()` without a delta from wheel and key handlers and `fitView`, which would otherwise add
	 * a fixed per-call rotation. A moved camera emits `change` (a render request only, see
	 * `handleViewChange`); flushing that request renders this frame instead of the next one. During
	 * a `flyTo` the orbit still turns the camera but leaves the pending frame to the flight, which
	 * steps from the turned direction before it renders. A
	 * throwing update, render or view listener turns the orbit off rather than leaving it enabled
	 * without a loop.
	 */
	private readonly stepAutoOrbit = (deltaSeconds: number) => {
		try {
			this.controls.autoRotate = true;
			this.orbitUpdating = true;
			try {
				this.controls.update(deltaSeconds);
			} finally {
				this.controls.autoRotate = false;
				this.orbitUpdating = false;
			}
			if (this.flight === null) this.flushRender();
		} catch (error) {
			this.stopAutoOrbit();
			throw error;
		}
	};

	private readGpuTimers() {
		const timer = this.gpuTimer;
		if (!timer) return;
		while (timer.pending.length > 0) {
			const query = timer.pending[0];
			if (!query || !timer.context.getQueryParameter(query, timer.context.QUERY_RESULT_AVAILABLE)) return;
			timer.pending.shift();
			if (!timer.context.getParameter(timer.extension.GPU_DISJOINT_EXT)) {
				this.gpuFrameMilliseconds = timer.context.getQueryParameter(query, timer.context.QUERY_RESULT) / 1_000_000;
			}
			timer.context.deleteQuery(query);
		}
	}

	/**
	 * Orbit frames skip materialization. In 3D the packed instances do not depend on camera
	 * orientation: there is no viewport culling, density LOD and edge tiers follow counts only,
	 * and the one orientation-dependent value (`worldUnitsPerPixel`, for edge hit slop) is used
	 * only by 2D picking. 3D picking raycasts the instances and screen positions are projected per
	 * call, so an orbit frame needs only a render, whose view listeners still run every frame.
	 */
	private readonly handleViewChange = () => {
		if (!this.orbitUpdating) this.materializeViewport();
		this.requestRender();
	};

	private createCamera(): GraphraumCamera {
		const aspect = containerAspect(this.container.clientWidth, this.container.clientHeight);
		return this.mode === "2d"
			? new OrthographicCamera(-1, 1, 1, -1, -100_000, 100_000)
			: new PerspectiveCamera(45, aspect, 0.1, 100_000);
	}

	private createControls() {
		const controls = new OrbitControls(this.camera, this.renderer.domElement);
		controls.enableDamping = false;
		controls.screenSpacePanning = true;
		configureControlsForMode(controls, this.mode);
		controls.addEventListener("change", this.handleViewChange);
		return controls;
	}

	private pickNode(clientX: number, clientY: number): string | null {
		if (!this.nodeMesh || !this.nodePickMesh) return null;
		const bounds = this.renderer.domElement.getBoundingClientRect();
		if (bounds.width === 0 || bounds.height === 0) return null;
		this.pointer.set(
			((clientX - bounds.left) / bounds.width) * 2 - 1,
			-((clientY - bounds.top) / bounds.height) * 2 + 1,
		);
		if (this.camera instanceof OrthographicCamera) {
			const world = new Vector3(this.pointer.x, this.pointer.y, 0).unproject(this.camera);
			const index = this.spatialGrid2d.pick(world.x, world.y);
			return index === null ? null : (this.nodeIds[index] ?? null);
		}
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const checkedInstances = new Set<number>();
		for (const hit of this.raycaster.intersectObject(this.nodePickMesh, false)) {
			if (hit.instanceId === undefined || checkedInstances.has(hit.instanceId)) continue;
			checkedInstances.add(hit.instanceId);
			const nodeIndex = this.visibleNodeIndices[hit.instanceId];
			if (nodeIndex === undefined) continue;
			const node = this.data.nodes[nodeIndex];
			if (!node) continue;
			const { height, width } = resolveNodeAxes({
				height: node.height,
				nodeId: node.id,
				size: node.size,
				width: node.width,
			});
			this.pickCenter.set(node.position.x, node.position.y, node.position.z ?? 0).project(this.camera);
			this.pickRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(width);
			this.pickRight.set(
				this.pickRight.x + node.position.x,
				this.pickRight.y + node.position.y,
				this.pickRight.z + (node.position.z ?? 0),
			);
			this.pickRight.project(this.camera);
			this.pickUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(height);
			this.pickUp.set(
				this.pickUp.x + node.position.x,
				this.pickUp.y + node.position.y,
				this.pickUp.z + (node.position.z ?? 0),
			);
			this.pickUp.project(this.camera);
			const radiusNdcX = Math.abs(this.pickRight.x - this.pickCenter.x);
			const radiusNdcY = Math.abs(this.pickUp.y - this.pickCenter.y);
			if (radiusNdcX === 0 || radiusNdcY === 0) continue;
			const offsetX = (this.pointer.x - this.pickCenter.x) / radiusNdcX;
			const offsetY = (this.pointer.y - this.pickCenter.y) / radiusNdcY;
			if (containsNodePoint(node.shape, offsetX, offsetY)) return this.nodeIds[nodeIndex] ?? null;
		}
		return null;
	}

	private pickEdge(clientX: number, clientY: number): string | null {
		if (!this.edgeMesh || this.pickableEdgeSegments.length === 0) return null;
		const bounds = this.renderer.domElement.getBoundingClientRect();
		if (bounds.width === 0 || bounds.height === 0) return null;
		this.pointer.set(
			((clientX - bounds.left) / bounds.width) * 2 - 1,
			-((clientY - bounds.top) / bounds.height) * 2 + 1,
		);
		if (this.camera instanceof OrthographicCamera) {
			const world = new Vector3(this.pointer.x, this.pointer.y, 0).unproject(this.camera);
			const edgeIndex = pickClosestEdgeIndex({ x: world.x, y: world.y }, this.pickableEdgeSegments);
			return edgeIndex === null ? null : (this.data.edges[edgeIndex]?.id ?? null);
		}
		this.raycaster.setFromCamera(this.pointer, this.camera);
		for (const hit of this.raycaster.intersectObject(this.edgeMesh, false)) {
			if (hit.instanceId === undefined) continue;
			if (hit.instanceId >= this.visibleEdgeSegmentCount) continue;
			const edgeIndex = this.visibleEdgeSegmentEdgeIndices[hit.instanceId];
			if (edgeIndex === undefined) continue;
			return this.data.edges[edgeIndex]?.id ?? null;
		}
		return null;
	}

	private worldUnitsPerPixel(): number {
		const width = Math.max(this.renderer.domElement.clientWidth, 1);
		if (this.camera instanceof OrthographicCamera) {
			return (this.camera.right - this.camera.left) / (width * this.camera.zoom);
		}
		const bounds = this.renderer.domElement.getBoundingClientRect();
		const left = this.screenToWorld(bounds.left, bounds.top);
		const right = this.screenToWorld(bounds.left + 1, bounds.top);
		if (!left || !right) return 1;
		return Math.hypot(right.x - left.x, right.y - left.y) || 1;
	}

	private applySelectionColors(nodeIds: Iterable<string>) {
		if (!this.nodeMesh?.instanceColor) return;
		const slots: number[] = [];
		for (const nodeId of nodeIds) {
			const index = this.nodeIndices.get(nodeId);
			if (index === undefined) continue;
			const slot = this.visibleNodeSlots.get(index);
			if (slot === undefined) continue;
			const node = this.data.nodes[index];
			if (!node) continue;
			this.nodeMesh.setColorAt(slot, this.getNodeColor(node));
			slots.push(slot);
		}
		markInstanceColorSlots(this.nodeMesh.instanceColor, slots);
		this.glowLayer.rewrite(this.describeGlowNode);
	}

	/** Rebuilds the opt-in halo pass; graphs without glow release it and skip the visible scan. */
	private syncGlow() {
		if (!this.hasGlowNodes) {
			this.glowLayer.dispose();
			return;
		}
		this.glowLayer.setBlending(glowBlendModeFor(this.theme.background));
		this.glowLayer.sync(this.visibleNodeIndices, this.glowAt, this.densityLodActive, this.describeGlowNode);
	}

	private readonly glowAt = (nodeIndex: number) => this.data.nodes[nodeIndex]?.glow ?? 0;

	private readonly describeGlowNode = (nodeIndex: number, target: GlowNodeTarget) => {
		const node = this.data.nodes[nodeIndex];
		if (!node) return false;
		const { height, width } = resolveNodeAxes({
			height: node.height,
			nodeId: node.id,
			size: node.size,
			width: node.width,
		});
		target.color.copy(this.getNodeColor(node));
		target.extent = Math.max(width, height);
		target.glow = node.glow ?? 0;
		target.x = node.position.x;
		target.y = node.position.y;
		target.z = node.position.z ?? 0;
		return true;
	};

	private getNodeStateIds(state: GraphraumNodeState) {
		switch (state) {
			case "dimmed":
				return this.dimmedNodeIds;
			case "focused":
				return this.focusedNodeIds;
			case "hovered":
				return this.hoveredNodeIds;
			case "selected":
				return this.selectedNodeIds;
		}
	}

	private setNodeStateIds(state: GraphraumNodeState, nodeIds: Set<string>) {
		switch (state) {
			case "dimmed":
				this.dimmedNodeIds = nodeIds;
				return;
			case "focused":
				this.focusedNodeIds = nodeIds;
				return;
			case "hovered":
				this.hoveredNodeIds = nodeIds;
				return;
			case "selected":
				this.selectedNodeIds = nodeIds;
		}
	}

	private getNodeColor(node: GraphraumData<NodeAttributes, EdgeAttributes>["nodes"][number]) {
		if (this.focusedNodeIds.has(node.id)) return new Color(this.theme.focusedNode);
		if (this.selectedNodeIds.has(node.id)) return new Color(this.theme.selectedNode);
		if (this.hoveredNodeIds.has(node.id)) return new Color(this.theme.hoveredNode);
		if (this.dimmedNodeIds.has(node.id)) return new Color(this.theme.dimmedNode);
		return new Color(node.color ?? this.theme.node);
	}

	private getViewportBounds2d(): Bounds2D | null {
		if (!(this.camera instanceof OrthographicCamera) || !this.viewportCulling) return null;
		const bottomLeft = new Vector3(-1, -1, 0).unproject(this.camera);
		const topRight = new Vector3(1, 1, 0).unproject(this.camera);
		return { bottom: bottomLeft.y, left: bottomLeft.x, right: topRight.x, top: topRight.y };
	}

	private isNodeVisible2d(
		node: GraphraumData<NodeAttributes, EdgeAttributes>["nodes"][number],
		bounds: Bounds2D | null,
	) {
		if (!bounds) return true;
		const { height, width } = resolveNodeAxes({
			height: node.height,
			nodeId: node.id,
			size: node.size,
			width: node.width,
		});
		return (
			node.position.x + width >= bounds.left - this.viewportOverscan &&
			node.position.x - width <= bounds.right + this.viewportOverscan &&
			node.position.y + height >= bounds.bottom - this.viewportOverscan &&
			node.position.y - height <= bounds.top + this.viewportOverscan
		);
	}

	private disposeBackgroundTexture() {
		if (!this.backgroundTexture) return;
		this.backgroundTexture.dispose();
		this.backgroundTexture = null;
	}

	private createBackgroundTexture(source: CanvasImageSource, repeat: readonly [number, number] | undefined): Texture {
		const texture =
			source instanceof HTMLCanvasElement ||
			(typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas)
				? new CanvasTexture(source)
				: new Texture(source as HTMLImageElement | ImageBitmap | HTMLVideoElement);
		texture.colorSpace = SRGBColorSpace;
		texture.needsUpdate = true;
		const [repeatX, repeatY] = repeat ?? [1, 1];
		if (repeatX !== 1 || repeatY !== 1) {
			texture.wrapS = RepeatWrapping;
			texture.wrapT = RepeatWrapping;
			texture.repeat.set(repeatX, repeatY);
		}
		return texture;
	}

	private applyBackground() {
		this.disposeBackgroundTexture();
		const background = normalizeGraphraumBackground(this.theme.background);
		if (background === null) {
			this.scene.background = null;
			this.renderer.setClearColor(0x000000, 0);
			return;
		}
		if (typeof background === "object") {
			this.backgroundTexture = this.createBackgroundTexture(background.source, background.repeat);
			this.scene.background = this.backgroundTexture;
			this.renderer.setClearColor(0x000000, 1);
			return;
		}
		const color = new Color(background);
		this.scene.background = color;
		this.renderer.setClearColor(color, 1);
	}

	private materializeViewport() {
		if (!this.nodeMesh || !this.nodePickMesh || !this.edgeMesh) return;
		const bounds = this.getViewportBounds2d();
		const visibleNodeCandidates = bounds
			? this.spatialGrid2d.queryBounds(bounds, this.viewportOverscan)
			: this.data.nodes.map((_, index) => index);
		this.densityLodActive = shouldUseDensityLod(
			visibleNodeCandidates.length,
			this.maxVisibleNodes,
			this.densityLodActive,
		);
		const materializedNodes = this.materializeNodes(visibleNodeCandidates, bounds);
		const visibleNodeIndices = materializedNodes.map(({ index }) => index);
		const edgeCandidates = bounds
			? collectIncidentEdges(visibleNodeIndices, this.incidentEdgeIndices)
			: this.data.edges.map((_, index) => index);
		const visibleEdgeIndices = applyEdgeBudget(edgeCandidates, this.maxVisibleEdges);
		const matrix = new Matrix4();
		this.visibleNodeSlots = new Map();
		this.visibleNodeIndices = visibleNodeIndices;
		this.nodeMesh.instanceMatrix.clearUpdateRanges();
		this.nodePickMesh.instanceMatrix.clearUpdateRanges();
		this.nodeMesh.instanceColor?.clearUpdateRanges();
		const nodeShape = this.nodeMesh.geometry.getAttribute("instanceShape") as InstancedBufferAttribute;
		const nodeStrokeWidth = this.nodeMesh.geometry.getAttribute("instanceStrokeWidth") as InstancedBufferAttribute;
		const nodeStrokeColor = this.nodeMesh.geometry.getAttribute("instanceStrokeColor") as InstancedBufferAttribute;
		nodeShape.clearUpdateRanges();
		nodeStrokeWidth.clearUpdateRanges();
		nodeStrokeColor.clearUpdateRanges();
		for (const [slot, materialized] of materializedNodes.entries()) {
			const nodeIndex = materialized.index;
			const node = this.data.nodes[nodeIndex];
			if (!node) continue;
			this.visibleNodeSlots.set(nodeIndex, slot);
			const { height, width } = materialized;
			const maxAxis = Math.max(width, height);
			matrix.makeScale(width, height, maxAxis);
			matrix.setPosition(materialized.x, materialized.y, materialized.z);
			this.nodeMesh.setMatrixAt(slot, matrix);
			const pickScale = maxAxis * Math.SQRT2;
			matrix.makeScale(pickScale, pickScale, pickScale);
			matrix.setPosition(materialized.x, materialized.y, materialized.z);
			this.nodePickMesh.setMatrixAt(slot, matrix);
			this.nodeMesh.setColorAt(slot, this.getNodeColor(node));
			setNodeShapeAt(nodeShape, slot, node.shape);
			setNodeStrokeAt(nodeStrokeWidth, nodeStrokeColor, slot, resolveNodeStroke(node, this.theme));
		}
		this.nodeMesh.count = materializedNodes.length;
		this.nodePickMesh.count = materializedNodes.length;
		this.nodeMesh.instanceMatrix.addUpdateRange(0, materializedNodes.length * 16);
		this.nodeMesh.instanceMatrix.needsUpdate = true;
		this.nodePickMesh.instanceMatrix.addUpdateRange(0, materializedNodes.length * 16);
		this.nodePickMesh.instanceMatrix.needsUpdate = true;
		if (this.nodeMesh.instanceColor) {
			this.nodeMesh.instanceColor.addUpdateRange(0, materializedNodes.length * 3);
			this.nodeMesh.instanceColor.needsUpdate = true;
		}
		nodeShape.addUpdateRange(0, materializedNodes.length);
		nodeShape.needsUpdate = true;
		nodeStrokeWidth.addUpdateRange(0, materializedNodes.length);
		nodeStrokeWidth.needsUpdate = true;
		nodeStrokeColor.addUpdateRange(0, materializedNodes.length * 3);
		nodeStrokeColor.needsUpdate = true;

		const lodLevel = resolveLodLevel(this.densityLodActive, edgeCandidates.length, visibleEdgeIndices.length);
		this.lastEdgeLodTier = edgeTierFromDiagnosticsLod(lodLevel);
		const worldPerPixel = this.worldUnitsPerPixel();
		const packed = packEdgeInstances({
			edgeIndices: visibleEdgeIndices,
			edgeStates: this.edgeStateStyling(),
			edgeVisuals: this.data.edges,
			endpointPositions: this.canonicalEdgePositions,
			defaults: { color: this.theme.edge, opacity: this.theme.edgeOpacity, width: this.theme.edgeWidth },
			tier: this.lastEdgeLodTier,
			maxSegments: this.edgeSegmentCapacity,
			endpointAttach: this.theme.endpointAttach,
			edgeNodeIndices: this.edgeNodeIndices,
			mode: this.mode,
			nodeOutlines: this.data.nodes.map((node) => ({
				height: node.height,
				shape: node.shape,
				size: node.size,
				strokeWidth: node.strokeWidth,
				width: node.width,
			})),
		});
		const edgeGeometry = this.edgeMesh.geometry;
		this.visibleEdgeSlots = new Map();
		this.visibleEdgeLayouts = buildVisibleEdgeLayouts(packed.segments, packed.markers, packed.segments.length);
		this.pickableEdgeSegments = [];
		this.visibleEdgeSegmentEdgeIndices = [];
		let edgeSlot = 0;
		const distinctEdges = new Set<number>();
		const minHitSlop = Math.max(4 * worldPerPixel, this.theme.edgeWidth * worldPerPixel);
		for (const segment of packed.segments) {
			writeEdgeSegmentInstance(edgeGeometry, edgeSlot, segment);
			if (!this.visibleEdgeSlots.has(segment.edgeIndex)) {
				this.visibleEdgeSlots.set(segment.edgeIndex, edgeSlot);
			}
			distinctEdges.add(segment.edgeIndex);
			this.visibleEdgeSegmentEdgeIndices.push(segment.edgeIndex);
			this.pickableEdgeSegments.push({
				edgeIndex: segment.edgeIndex,
				hitSlop: Math.max(minHitSlop, (segment.width * worldPerPixel) / 2 + 2 * worldPerPixel),
				x1: segment.x1,
				y1: segment.y1,
				x2: segment.x2,
				y2: segment.y2,
			});
			edgeSlot += 1;
		}
		const segmentCount = edgeSlot;
		for (const marker of packed.markers) {
			writeEdgeMarkerInstance(edgeGeometry, edgeSlot, marker);
			edgeSlot += 1;
		}
		this.edgeMesh.count = edgeSlot;
		for (const name of EDGE_INSTANCE_ATTRIBUTES) {
			const attribute = edgeGeometry.getAttribute(name) as InstancedBufferAttribute;
			attribute.clearUpdateRanges();
			attribute.addUpdateRange(0, edgeSlot * attribute.itemSize);
			attribute.needsUpdate = true;
		}

		this.visibleNodeCandidateCount = visibleNodeCandidates.length;
		this.visibleNodeCount = materializedNodes.length;
		this.visibleEdgeCandidateCount = edgeCandidates.length;
		this.visibleEdgeSegmentCount = segmentCount;
		this.visibleEdgeCount = distinctEdges.size;
		this.visibleEdgeMarkerCount = packed.markers.length;
		this.syncGlow();
	}

	private materializeNodes(indices: readonly number[], bounds: Bounds2D | null): readonly MaterializedNode[] {
		if (!this.densityLodActive || !bounds) {
			return indices.slice(0, this.maxVisibleNodes).flatMap((index) => {
				const node = this.data.nodes[index];
				if (!node) return [];
				const { height, width } = resolveNodeAxes({
					height: node.height,
					nodeId: node.id,
					size: node.size,
					width: node.width,
				});
				return [{ height, index, width, x: node.position.x, y: node.position.y, z: node.position.z ?? 0 }];
			});
		}
		const aspect = Math.max(this.container.clientWidth, 1) / Math.max(this.container.clientHeight, 1);
		const columns = Math.max(1, Math.floor(Math.sqrt(this.maxVisibleNodes * aspect)));
		const rows = Math.max(1, Math.floor(this.maxVisibleNodes / columns));
		const cellWidth = Math.max((bounds.right - bounds.left) / columns, Number.EPSILON);
		const cellHeight = Math.max((bounds.top - bounds.bottom) / rows, Number.EPSILON);
		// Clusters collapse many nodes into one representative blob, so the aggregated footprint
		// is a uniform width/height square sized by the largest member's max(width, height).
		const clusters = new Map<string, MaterializedNode & { count: number }>();
		for (const index of indices) {
			const node = this.data.nodes[index];
			if (!node) continue;
			const axes = resolveNodeAxes({ height: node.height, nodeId: node.id, size: node.size, width: node.width });
			const axisSize = Math.max(axes.width, axes.height);
			const x = Math.min(columns - 1, Math.max(0, Math.floor((node.position.x - bounds.left) / cellWidth)));
			const y = Math.min(rows - 1, Math.max(0, Math.floor((node.position.y - bounds.bottom) / cellHeight)));
			const key = `${x}:${y}`;
			const cluster = clusters.get(key);
			if (!cluster) {
				clusters.set(key, {
					count: 1,
					height: axisSize,
					index,
					width: axisSize,
					x: node.position.x,
					y: node.position.y,
					z: node.position.z ?? 0,
				});
				continue;
			}
			cluster.count += 1;
			cluster.x += (node.position.x - cluster.x) / cluster.count;
			cluster.y += (node.position.y - cluster.y) / cluster.count;
			cluster.z += ((node.position.z ?? 0) - cluster.z) / cluster.count;
			const grownAxis = Math.min(Math.max(cluster.width, axisSize) + 0.25, 16);
			cluster.width = grownAxis;
			cluster.height = grownAxis;
		}
		return [...clusters.values()].slice(0, this.maxVisibleNodes);
	}

	private disposeGraphObjects() {
		this.glowLayer.dispose();
		this.pickableEdgeSegments = [];
		this.visibleEdgeSegmentEdgeIndices = [];
		this.visibleEdgeLayouts = new Map();
		if (this.nodeMesh) {
			this.scene.remove(this.nodeMesh);
			this.nodeMesh.geometry.dispose();
			disposeMaterial(this.nodeMesh.material);
			this.nodeMesh = null;
		}
		if (this.nodePickMesh) {
			this.nodePickMesh.geometry.dispose();
			disposeMaterial(this.nodePickMesh.material);
			this.nodePickMesh = null;
		}
		if (this.edgeMesh) {
			this.scene.remove(this.edgeMesh);
			this.edgeMesh.geometry.dispose();
			disposeMaterial(this.edgeMesh.material);
			this.edgeMesh = null;
		}
	}
}

/** The 2D fit: the nodes' padded bounds, framed with 15% slack on the tighter axis. */
function orthographicFit<NodeAttributes>(aspect: number, nodes: GraphraumNodes<NodeAttributes>): OrthographicFit {
	const bounds = new Box3();
	const minimum = new Vector3();
	const maximum = new Vector3();
	for (const node of nodes) {
		const { height, width } = resolveNodeAxes({
			height: node.height,
			nodeId: node.id,
			size: node.size,
			width: node.width,
		});
		const radius = Math.max(width, height);
		const z = node.position.z ?? 0;
		bounds.expandByPoint(minimum.set(node.position.x - radius, node.position.y - radius, z - radius));
		bounds.expandByPoint(maximum.set(node.position.x + radius, node.position.y + radius, z + radius));
	}
	const center = bounds.getCenter(new Vector3());
	const size = bounds.getSize(new Vector3());
	return {
		cameraZ: center.z + Math.max(size.z, 1000),
		center,
		visibleHeight: Math.max(size.y, size.x / aspect, 1) * 1.15,
	};
}

/** Sets a frustum that shows `visibleHeight` world units at zoom 1 and resets the zoom. */
function setOrthographicFrustum(camera: OrthographicCamera, aspect: number, visibleHeight: number) {
	camera.left = (-visibleHeight * aspect) / 2;
	camera.right = (visibleHeight * aspect) / 2;
	camera.top = visibleHeight / 2;
	camera.bottom = -visibleHeight / 2;
	// Wheel zoom scales `camera.zoom`; the frustum frames the graph only at zoom 1.
	camera.zoom = 1;
}

function hasNodeGlow(node: { glow?: number }): boolean {
	return (node.glow ?? 0) > 0;
}

function nextCapacity(length: number): number {
	let capacity = 1;
	while (capacity < length) capacity *= 2;
	return capacity;
}

/**
 * Segment capacity is edgeCapacity × DETAIL_MAX_SEGMENTS (cubic worst case).
 * Marker capacity is always exactly 2× edge capacity (both ends) — never derived from
 * `nextCapacity(edgeCount * 2)` independently, which can undershoot for small edge counts
 * and let a later append with `markerEnd: "both"` overrun the instanced buffer.
 */
export function edgeInstanceCapacities(edgeCount: number, maxVisibleEdges: number) {
	const edgeCapacity = Math.min(maxVisibleEdges, nextCapacity(edgeCount));
	const segmentCapacity = edgeCapacity * DETAIL_MAX_SEGMENTS;
	const markerCapacity = edgeCapacity * 2;
	return {
		edgeCapacity,
		segmentCapacity,
		markerCapacity,
		edgeInstanceCapacity: segmentCapacity + markerCapacity,
	};
}
