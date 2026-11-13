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
	ShaderMaterial,
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
import { createColorResolver } from "./color-cache";
import { compileGraph } from "./compile-graph";
import { dataPatchFitsCapacity, isAppendOnlyDataPatch, type MergedGraphData, mergeDataPatch } from "./data-patch";
import {
	DEPTH_OF_FIELD_APERTURE_CSS_PIXELS,
	DEPTH_OF_FIELD_DEFAULTS,
	DEPTH_OF_FIELD_MIN_BLUR_PIXELS,
	DepthOfFieldFocus,
	distanceFade,
	type FocusPoint,
	meanPoint,
	type ResolvedDepthOfFieldOptions,
	resolveDepthOfFieldOptions,
	resolveEasing,
	Tween,
	viewDistance,
} from "./depth-of-field";
import { type DepthOfFieldFrame, DepthOfFieldPass } from "./depth-of-field-pass";
import {
	type EdgeMarkerInstance,
	type EdgeSegmentInstance,
	edgeTierFromDiagnosticsLod,
	packEdgeInstances,
} from "./edge-materialize";
import { DETAIL_MAX_SEGMENTS, type EdgeLodTier } from "./edge-paths";
import { type PickableEdgeSegment, pickableSegment, pickClosestEdgeIndex } from "./edge-picking";
import {
	createEdgeGeometry,
	createEdgeMaterial,
	createEdgeMesh,
	EDGE_INSTANCE_ATTRIBUTES,
	EDGE_RENDER_ORDER,
	edgeGeometryCapacity,
	getInstancedAttribute,
	resizeEdgeGeometry,
	writeEdgeMarkerInstance,
	writeEdgeSegmentInstance,
} from "./edge-rendering";
import { EdgeSlotPool, EdgeVisibility } from "./edge-slot-pool";
import { changedIds, type EdgeStateStyling } from "./edge-state";
import {
	appendVisibleEdgeLayouts,
	buildVisibleEdgeLayouts,
	patchVisibleEdgeInstances,
	patchVisibleEdgePaint,
	type VisibleEdgeLayout,
} from "./edge-viewport-patch";
import { fitPerspective, type PerspectiveFit } from "./fit-3d";
import {
	FOCUS_LENS_DEFAULTS,
	focusLensLabelAlpha,
	focusLensScale,
	type ResolvedFocusLensOptions,
	resolveFocusLensOptions,
} from "./focus-lens";
import { markInstanceColorSlots } from "./instance-color-ranges";
import {
	INTERACTION_QUALITY_DEFAULTS,
	INTERACTION_TIERS,
	InteractionQualityGovernor,
	type ResolvedInteractionQualityOptions,
	resolveInteractionQualityOptions,
	scaledBudget,
	scaledPixelRatio,
} from "./interaction-quality";
import { prepareLayoutPositions } from "./layout-positions";
import { resolveNodeAxes } from "./node-axes";
import { NodeDragController } from "./node-drag";
import { createNodeDragSurface } from "./node-drag-surface";
import { glowBlendModeFor, glowHaloRadius } from "./node-glow";
import { type GlowNodeTarget, NodeGlowLayer } from "./node-glow-rendering";
import {
	assertIconAtlas,
	assertIconScale,
	assertNodeIconInAtlas,
	type GraphraumIconAtlas,
	type GraphraumIconOptions,
} from "./node-icon";
import {
	allocateNodeInstanceColors,
	configureNodeMaterial,
	createNodeGeometry,
	createNodeMaterial,
	NODE_RENDER_ORDER,
	setNodeBlendAt,
	setNodeIconAt,
	setNodeLighting,
	setNodeShapeAt,
	setNodeStrokeAt,
} from "./node-rendering";
import { containsNodePoint } from "./node-shapes";
import { resolveNodeStroke } from "./node-stroke";
import { type PreparedNodeUpdate, prepareNodeUpdates } from "./node-updates";
import { configureControlsForMode } from "./orbit-controls-mode";
import { GraphraumOverlay } from "./overlay";
import { RadialCrispLayer } from "./radial-crisp-layer";
import {
	crispEdgeIndices,
	crispNodeIndices,
	RADIAL_MIN_BLUR_PIXELS,
	type RadialFocusFrame,
	vignetteTone,
} from "./radial-focus";
import { RadialFocusPass } from "./radial-focus-pass";
import { resolveSceneDrawSetup, resolveSceneOptions, SCENE_DEFAULTS, sceneLightColours, sunDirection } from "./scene";
import { type Bounds2D, SpatialGrid2D } from "./spatial-grid-2d";
import { applyLabelVariables, resolveStyleExtras, STYLE_DEFAULTS, type StyleExtras } from "./style";
import { normalizeGraphraumBackground, resolveGraphraumTheme } from "./theme";
import type {
	CompiledGraphraumPresentation,
	GraphraumAutoOrbitOptions,
	GraphraumBackground,
	GraphraumCameraState,
	GraphraumColor,
	GraphraumData,
	GraphraumDataPatch,
	GraphraumDepthOfFieldOptions,
	GraphraumDepthOfFieldStatus,
	GraphraumDepthOfFieldUpdate,
	GraphraumDiagnostics,
	GraphraumEdge,
	GraphraumEdgeState,
	GraphraumFlyToOptions,
	GraphraumFocusLensOptions,
	GraphraumInteractionQualityOptions,
	GraphraumLabelCandidate,
	GraphraumLayoutPositions,
	GraphraumMode,
	GraphraumNode,
	GraphraumNodeDragEvent,
	GraphraumNodeDragOptions,
	GraphraumNodeState,
	GraphraumNodeUpdate,
	GraphraumOptions,
	GraphraumOverlayOptions,
	GraphraumPickHit,
	GraphraumPosition,
	GraphraumSceneOptions,
	GraphraumScreenPosition,
	GraphraumSetDataOptions,
	GraphraumStyleInput,
	GraphraumTheme,
	GraphraumThemeName,
	GraphraumVisualMapper,
	ResolvedGraphraumSceneOptions,
} from "./types";
import {
	applyEdgeBudget,
	collectIncidentEdges,
	dropSubPixelEdges,
	endpointDegreeScore,
	resolveLodLevel,
	shouldUseDensityLod,
} from "./viewport-lod";

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

/** The instanced attributes one node's slot is written into. */
interface NodeInstanceTargets {
	blendA: InstancedBufferAttribute;
	blendB: InstancedBufferAttribute;
	icon: InstancedBufferAttribute;
	matrix: Matrix4;
	shape: InstancedBufferAttribute;
	strokeColor: InstancedBufferAttribute;
	strokeWidth: InstancedBufferAttribute;
}

interface GpuTimer {
	extension: { GPU_DISJOINT_EXT: number; TIME_ELAPSED_EXT: number };
	context: WebGL2RenderingContext;
	pending: WebGLQuery[];
}

function disposeMaterial(material: Material | Material[]) {
	for (const item of Array.isArray(material) ? material : [material]) item.dispose();
}

/** Overview edges shorter than this many CSS pixels on screen are not drawn. */
const SUB_PIXEL_EDGE_PIXELS = 0.75;
/** Spare edge instances after the budgeted layer, for the selection overlay. */
const OVERLAY_INSTANCE_RESERVE = 32_768;
/** Edge instance slots allocated before the first pass says how many are drawn. */
const INITIAL_EDGE_INSTANCES = 1_024;
/** Slots held beyond the ones in use, so a small pass does not reallocate on the next appended edge. */
const MIN_EDGE_HEADROOM = 1_024;
const NO_PINNED_EDGES: ReadonlySet<number> = new Set();

/** One warning per page when a context cannot run depth of field; diagnostics report it per instance. */
let warnedDepthOfFieldUnsupported = false;

/** A lens size closer than this to its target counts as arrived, which ends the easing frames. */
const LENS_SETTLE_EPSILON = 0.002;

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
	private extras: StyleExtras = STYLE_DEFAULTS;
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
	private iconSetup: { atlas: GraphraumIconAtlas; options: GraphraumIconOptions } | null = null;
	private nodeMesh: InstancedMesh | null = null;
	private nodePickMesh: InstancedMesh | null = null;
	private edgeMesh: InstancedMesh | null = null;
	private readonly glowLayer = new NodeGlowLayer(this.scene);
	private hasGlowNodes = false;
	private nodeCapacity = 0;
	private edgeCapacity = 0;
	private markerCapacity = 0;
	private edgeInstanceCapacity = 0;
	private edgePoolCapacity = 0;
	private selectedNodeIds = new Set<string>();
	private selectedEdgeIds = new Set<string>();
	private dimmedEdgeIds = new Set<string>();
	private edgeColors = new Map<string, GraphraumColor>();
	private edgeIndexCache: { edges: readonly unknown[]; indices: Map<string, number> } = {
		edges: [],
		indices: new Map(),
	};
	private hoveredNodeIds = new Set<string>();
	private focusedNodeIds = new Set<string>();
	private dimmedNodeIds = new Set<string>();
	/** Instance slot of each node index drawn as itself, -1 for the others. */
	private nodeSlots = new Int32Array(0);
	/** False while the slots hold density-tier clusters, whose instances are not the nodes'. */
	private nodeSlotsPlain = false;
	private slotKeep = new Uint8Array(0);
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
	private subPixelEdgesSkipped = 0;
	/**
	 * The budgeted layer, packed without regard to selection: slots `[0, extent)`.
	 */
	private mainEdge = { edges: 0, extent: 0, markers: 0, segments: 0, subPixelSkipped: 0 };
	/**
	 * While true the main layer sits in `edgePool` runs, and `edgeVisibility` counts the drawn nodes'
	 * edges, so a camera move writes only the edges that enter and frees the ones that leave.
	 */
	private edgePoolLive = false;
	private readonly edgePool = new EdgeSlotPool();
	private readonly edgeVisibility = new EdgeVisibility();
	/** Pinned edges the budget left out, drawn after the main layer. Rebuilt on a selection change. */
	private overlayEdgeIndices: readonly number[] = [];
	private edgeSegmentCapacity = 0;
	private mode: GraphraumMode;
	private frameRequest: number | null = null;
	private autoOrbit: AutoOrbitLoop | null = null;
	private flight: ActiveCameraFlight | null = null;
	private readonly flightDirection = new Vector3();
	/** True only during the orbit's own `controls.update(dt)`; see `handleViewChange`. */
	private orbitUpdating = false;
	private readonly resolveColor = createColorResolver();
	private basePixelRatio = 1;
	private interactionQuality: ResolvedInteractionQualityOptions = INTERACTION_QUALITY_DEFAULTS;
	private qualityGovernor: InteractionQualityGovernor | null = null;
	private destroyed = false;
	private canvasWidth = 0;
	private canvasHeight = 0;
	private cpuFrameMilliseconds = 0;
	private gpuFrameMilliseconds: number | null = null;
	private gpuTimer: GpuTimer | null = null;
	private readonly viewListeners = new Set<() => void>();
	private readonly focusListeners = new Set<() => void>();
	private readonly nodeDragListeners = new Set<(event: GraphraumNodeDragEvent) => void>();
	private readonly nodeDrag: NodeDragController;
	private lastHoveredNodeId: string | null = null;
	private readonly antialias: boolean;
	private depthOfField: ResolvedDepthOfFieldOptions = DEPTH_OF_FIELD_DEFAULTS;
	private scene3d: ResolvedGraphraumSceneOptions = SCENE_DEFAULTS;
	private readonly depthOfFieldFocus = new DepthOfFieldFocus();
	/** Strength actually applied: fades toward `strength` while enabled and toward 0 when disabled. */
	private readonly depthOfFieldStrength = new Tween(0);
	/** The same for `nearStrength`, faded alongside. */
	private readonly depthOfFieldNearStrength = new Tween(0);
	private depthOfFieldPass: DepthOfFieldPass | null = null;
	private radialFocusPass: RadialFocusPass | null = null;
	private radialCrispLayer: RadialCrispLayer | null = null;
	private depthOfFieldStatus: GraphraumDepthOfFieldStatus = "off";
	private focusLens: ResolvedFocusLensOptions = FOCUS_LENS_DEFAULTS;
	/** Size factor shown for each node, by node index; 0 means not set yet. Sized on demand. */
	private lensScales = new Float32Array(0);
	/** True once lens factors were written to the GPU, so turning the lens off knows to reset them. */
	private lensApplied = false;
	private readonly lensMatrix = new Matrix4();

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
		if (options.style) this.mergeStyle(options.style);
		if (options.scene !== undefined) this.scene3d = resolveSceneOptions(options.scene);
		if (options.depthOfField !== undefined) {
			this.depthOfField = resolveDepthOfFieldOptions(options.depthOfField);
			void this.depthOfFieldStrength.retarget(this.depthOfFieldTargetStrength(), 0, resolveEasing("linear"));
			void this.depthOfFieldNearStrength.retarget(this.depthOfFieldTargetNearStrength(), 0, resolveEasing("linear"));
		}
		if (options.focusLens !== undefined) this.focusLens = resolveFocusLensOptions(options.focusLens);
		this.antialias = options.antialias ?? false;
		this.renderer = new WebGLRenderer({ antialias: this.antialias, alpha: true });
		this.applyBackground();
		const context = this.renderer.getContext();
		if (typeof WebGL2RenderingContext !== "undefined" && context instanceof WebGL2RenderingContext) {
			const extension = context.getExtension("EXT_disjoint_timer_query_webgl2");
			if (extension) this.gpuTimer = { context, extension, pending: [] };
		}
		this.basePixelRatio = Math.min(window.devicePixelRatio, options.maxPixelRatio ?? 2);
		this.renderer.setPixelRatio(this.basePixelRatio);
		this.renderer.domElement.style.display = "block";
		this.renderer.domElement.style.height = "100%";
		this.renderer.domElement.style.width = "100%";
		this.container.append(this.renderer.domElement);
		this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
		this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
		for (const type of FLIGHT_CANCEL_EVENTS) this.renderer.domElement.addEventListener(type, this.cancelFlight);
		// Before the camera controls attach theirs: a press on a node must reach the drag first.
		this.nodeDrag = new NodeDragController(this.createNodeDragHost());

		this.camera = this.createCamera();
		this.controls = this.createControls();
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(container);
		this.resize();
		if (options.interactionQuality !== undefined) this.setInteractionQuality(options.interactionQuality);
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

	/** Takes the compiled graph as the current data, with the compiled visuals merged into each node and edge. */
	private adoptCompiled(
		source: GraphraumData<NodeAttributes, EdgeAttributes>,
		compiled: ReturnType<typeof compileGraph<NodeAttributes, EdgeAttributes>>,
	) {
		// Without a visual mapper the compiled visual is the node's or edge's own fields, so the objects
		// the caller passed are kept as they are. Copying them cost two objects per node and one per
		// edge, which at millions of elements was most of the heap. The engine never edits them in place.
		this.data = {
			edges: this.visuals?.edge
				? source.edges.map((edge, index) => ({ ...edge, ...compiled.edgeVisuals[index] }))
				: source.edges.slice(),
			nodes: this.visuals?.node
				? source.nodes.map((node, index) => ({
						...node,
						...compiled.nodeVisuals[index],
						position: { ...node.position },
					}))
				: source.nodes.slice(),
		};
		this.nodeIds = compiled.nodeIds;
		this.hasGlowNodes = this.data.nodes.some(hasNodeGlow);
		this.nodeIndices = compiled.nodeIndices;
		this.lensScales.fill(0);
		this.edgeNodeIndices = compiled.edgeNodeIndices;
		this.canonicalEdgePositions = compiled.edgePositions;
		this.incidentEdgeIndices = compiled.incidentEdgeIndices;
		this.nodePresentations = compiled.nodePresentations;
		this.edgePresentations = compiled.edgePresentations;
		this.spatialGrid2d = new SpatialGrid2D();
		for (const [index, node] of this.data.nodes.entries()) this.spatialGrid2d.set(index, node);
	}

	private mutateDataInPlace(merged: MergedGraphData<NodeAttributes, EdgeAttributes>) {
		const compiled = compileGraph(merged, this.visuals);
		this.assertIconsInAtlas(compiled);
		this.adoptCompiled(merged, compiled);
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
		// The arrays below belong to this instance (replaceData builds them), so they grow in place.
		const nodes = this.data.nodes as GraphraumNode<NodeAttributes>[];
		const edges = this.data.edges as GraphraumEdge<EdgeAttributes>[];
		const previous = { edges: edges.length, nodes: nodes.length };

		const added = new Map(addedNodes.map((node) => [node.id, node]));
		const nodeById = (id: string) => added.get(id) ?? nodes[this.nodeIndices.get(id) ?? -1];
		// The patch compiles with the endpoints of its edges, which may be nodes that are already drawn.
		const patchNodes = new Map<string, GraphraumNode<NodeAttributes>>(added);
		for (const edge of addedEdges) {
			for (const id of [edge.source, edge.target]) {
				const node = nodeById(id);
				if (node && !patchNodes.has(id)) patchNodes.set(id, node);
			}
		}
		const compiled = compileGraph({ nodes: [...patchNodes.values()], edges: addedEdges }, this.visuals);
		this.assertIconsInAtlas(compiled);
		const nodeVisuals = new Map([...patchNodes.keys()].map((id, index) => [id, compiled.nodeVisuals[index]]));

		const nodeIds = this.nodeIds as string[];
		const incidentEdges = this.incidentEdgeIndices as number[][];
		for (const node of addedNodes) {
			const index = nodes.length;
			this.nodeIndices.set(node.id, index);
			nodeIds.push(node.id);
			nodes.push({ ...node, ...nodeVisuals.get(node.id), position: { ...node.position } });
			incidentEdges.push([]);
			this.spatialGrid2d.set(index, nodes[index] as GraphraumNode<NodeAttributes>);
		}
		this.edgeNodeIndices = grown(this.edgeNodeIndices, (previous.edges + addedEdges.length) * 2);
		this.canonicalEdgePositions = grown(this.canonicalEdgePositions, (previous.edges + addedEdges.length) * 6);
		for (const [offset, edge] of addedEdges.entries()) {
			const index = previous.edges + offset;
			const source = this.nodeIndices.get(edge.source);
			const target = this.nodeIndices.get(edge.target);
			edges.push({ ...edge, ...compiled.edgeVisuals[offset] });
			if (source === undefined || target === undefined) continue;
			this.edgeNodeIndices[index * 2] = source;
			this.edgeNodeIndices[index * 2 + 1] = target;
			incidentEdges[source]?.push(index);
			if (target !== source) incidentEdges[target]?.push(index);
			const sourceNode = nodes[source];
			const targetNode = nodes[target];
			if (!sourceNode || !targetNode) continue;
			this.canonicalEdgePositions.set(
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
		// The id index is keyed by the identity of the edges array, which an in-place append keeps.
		if (this.edgeIndexCache.edges === edges) {
			for (const [offset, edge] of addedEdges.entries())
				this.edgeIndexCache.indices.set(edge.id, previous.edges + offset);
		}
		const addedGlow = addedNodes.some(hasNodeGlow);
		this.hasGlowNodes ||= addedGlow;
		for (const [id, presentation] of compiled.nodePresentations) this.nodePresentations.set(id, presentation);
		for (const [id, presentation] of compiled.edgePresentations) this.edgePresentations.set(id, presentation);
		if (this.materializeAppended(previous)) {
			if (addedGlow) this.syncGlow();
		} else {
			this.materializeViewport();
		}
		this.requestRender();
	}

	/**
	 * Draws appended nodes and edges without repacking the ones already drawn. It applies only when the
	 * last pass drew the whole graph in index order, so the appended ones land after the existing ones
	 * exactly where a full pass would put them: 3D, or 2D without viewport culling, and no density or
	 * overview tier before or after. Returns false, having written nothing, when it does not apply.
	 */
	private materializeAppended(previous: { edges: number; nodes: number }): boolean {
		const { edgeMesh, nodeMesh, nodePickMesh } = this;
		if (!nodeMesh || !nodePickMesh || !edgeMesh) return false;
		const total = { edges: this.data.edges.length, nodes: this.data.nodes.length };
		const drewEverything =
			this.visibleNodeCount === previous.nodes && this.visibleEdgeCandidateCount === previous.edges;
		if (
			this.getViewportBounds2d() !== null ||
			this.densityLodActive ||
			this.lastEdgeLodTier !== "detail" ||
			this.overlayEdgeIndices.length > 0 ||
			!drewEverything ||
			total.nodes > this.maxVisibleNodes ||
			total.edges > this.maxVisibleEdges
		) {
			return false;
		}

		const segmentsBefore = this.visibleEdgeSegmentCount;
		const markersBefore = this.visibleEdgeMarkerCount;
		const packed = this.packEdges(
			Array.from({ length: total.edges - previous.edges }, (_, offset) => previous.edges + offset),
			this.edgeSegmentCapacity - segmentsBefore,
		);
		const segmentsTotal = segmentsBefore + packed.segments.length;
		const markersTotal = markersBefore + packed.markers.length;
		if (packed.truncated || markersTotal > this.markerCapacity) return false;

		// Nodes: one slot each, after the slots already drawn.
		const firstNodeSlot = this.visibleNodeCount;
		const targets = this.nodeInstanceTargets();
		for (let index = previous.nodes; index < total.nodes; index += 1) {
			const materialized = this.plainMaterializedNode(index);
			const node = this.data.nodes[index];
			if (!materialized || !node) continue;
			const slot = firstNodeSlot + (index - previous.nodes);
			this.assignNodeSlot(index, slot);
			(this.visibleNodeIndices as number[]).push(index);
			this.writeNodeInstance(targets, slot, materialized, node);
		}
		this.markNodeInstances([[firstNodeSlot, total.nodes]], total.nodes, false);

		// Edges: new segments take the first slots after the old ones, so the markers move up to make room.
		this.reserveEdgeInstances(segmentsTotal + markersTotal, segmentsBefore + markersBefore);
		const edgeGeometry = edgeMesh.geometry;
		if (packed.segments.length > 0 && markersBefore > 0) {
			for (const name of EDGE_INSTANCE_ATTRIBUTES) {
				const attribute = getInstancedAttribute(edgeGeometry, name);
				attribute.array.copyWithin(
					(segmentsBefore + packed.segments.length) * attribute.itemSize,
					segmentsBefore * attribute.itemSize,
					(segmentsBefore + markersBefore) * attribute.itemSize,
				);
			}
		}
		appendVisibleEdgeLayouts(this.visibleEdgeLayouts, packed.segments, packed.markers, {
			markerStart: segmentsTotal + markersBefore,
			segmentStart: segmentsBefore,
			segmentTotal: segmentsTotal,
		});
		const addedEdgeCount = this.writeEdgeInstances(packed, {
			markerStart: segmentsTotal + markersBefore,
			segmentStart: segmentsBefore,
		});
		edgeMesh.count = segmentsTotal + markersTotal;
		this.markEdgeInstances(segmentsBefore, segmentsTotal + markersTotal, false);

		this.visibleNodeCandidateCount = total.nodes;
		this.visibleNodeCount = total.nodes;
		this.visibleEdgeCandidateCount = total.edges;
		this.visibleEdgeSegmentCount = segmentsTotal;
		this.visibleEdgeCount += addedEdgeCount;
		this.visibleEdgeMarkerCount = markersTotal;
		this.mainEdge = {
			...this.mainEdge,
			edges: this.visibleEdgeCount,
			extent: segmentsTotal + markersTotal,
			markers: markersTotal,
			segments: segmentsTotal,
		};
		return true;
	}

	private replaceData(data: GraphraumData<NodeAttributes, EdgeAttributes>, fitView: boolean) {
		this.nodeDrag.cancel({ restore: false });
		const compiled = compileGraph(data, this.visuals);
		this.assertIconsInAtlas(compiled);
		this.disposeGraphObjects();
		this.adoptCompiled(data, compiled);
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
		this.edgePoolCapacity = capacities.edgeInstanceCapacity;
		this.edgeInstanceCapacity =
			capacities.edgeInstanceCapacity + Math.min(OVERLAY_INSTANCE_RESERVE, capacities.edgeInstanceCapacity);
		// Room for the slots in use grows with the first and later passes (`reserveEdgeInstances`); the
		// capacity above is only the most a pass may ever use.
		const edgeGeometry = createEdgeGeometry(Math.min(INITIAL_EDGE_INSTANCES, this.edgeInstanceCapacity));
		const edgeMaterial = createEdgeMaterial();
		const edgeMesh = createEdgeMesh(edgeGeometry, edgeMaterial);
		edgeMesh.frustumCulled = false;
		edgeMesh.renderOrder = EDGE_RENDER_ORDER;
		this.edgeMesh = edgeMesh;
		this.scene.add(edgeMesh);
		this.applySceneDrawSetup();

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
		if (this.iconSetup) {
			for (const { iconChanged, next } of prepared) {
				if (iconChanged) assertNodeIconInAtlas(next.id, next.icon, this.iconSetup.atlas.count);
			}
		}
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
		const nodeIcon = nodeMesh.geometry.getAttribute("instanceIcon") as InstancedBufferAttribute;
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
				const wasVisible = this.visibleNodeSlot(update.index) !== undefined;
				this.spatialGrid2d.set(update.index, update.next);
				visibilityChanged ||= wasVisible !== this.isNodeVisible2d(update.next, viewportBounds);
			}
			const nodeSlot = this.visibleNodeSlot(update.index);
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
					const pickScale = maxAxis * Math.SQRT2 * this.lensPickGrowth();
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
			if (update.iconChanged && nodeSlot !== undefined) {
				setNodeIconAt(nodeIcon, nodeSlot, update.next.icon);
				nodeIcon.addUpdateRange(nodeSlot, 1);
			}
			if (update.shapeChanged && nodeSlot !== undefined) {
				setNodeShapeAt(nodeShape, nodeSlot, update.next.shape);
				nodeShape.addUpdateRange(nodeSlot, 1);
			}
			if (update.strokeChanged && nodeSlot !== undefined) {
				setNodeStrokeAt(
					nodeStrokeWidth,
					nodeStrokeColor,
					nodeSlot,
					resolveNodeStroke(update.next, this.theme, this.extras.node.strokeWidth),
				);
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
		if (prepared.some((update) => update.iconChanged)) nodeIcon.needsUpdate = true;
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
		const result = patchVisibleEdgeInstances(
			this.edgeMesh.geometry,
			{
				changedEdgeIndices,
				defaults: this.edgeDefaults(),
				edgeNodeIndices: this.edgeNodeIndices,
				edgeStates: this.edgeStateStyling(),
				edgeVisuals: this.data.edges,
				endpointAttach: this.endpointAttach(),
				endpointPositions: this.canonicalEdgePositions,
				layouts: this.visibleEdgeLayouts,
				minHitSlop: Math.max(4, this.theme.edgeWidth),
				mode: this.mode,
				nodeOutlines: this.data.nodes,
				pickable: this.camera instanceof OrthographicCamera,
				tier: this.lastEdgeLodTier,
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
		// Over the edge budget a selected edge is pinned: it joins the overlay, not the budgeted layer.
		if (changed.length > 0 && this.edgeBudgetActive()) this.syncPinnedOverlay();
	}

	private edgeBudgetActive() {
		return this.visibleEdgeCandidateCount > this.mainEdge.edges;
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

	/**
	 * Paints edges in host colours without changing source graph data, for example one colour per
	 * relation around a focused node. Replaces the previous set; an empty map clears it. Selection and
	 * dimming still win. A repaint in place: no recompile and no extra draw call. Unknown IDs are ignored.
	 */
	setEdgeColors(colors: ReadonlyMap<string, GraphraumColor> | Iterable<readonly [string, GraphraumColor]>) {
		const indices = this.edgeIndicesById();
		const next = new Map<string, GraphraumColor>();
		for (const [id, color] of colors) if (indices.has(id)) next.set(id, color);
		const changed = [...this.edgeColors.keys()].filter((id) => next.get(id) !== this.edgeColors.get(id));
		for (const id of next.keys()) if (!this.edgeColors.has(id)) changed.push(id);
		this.edgeColors = next;
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
			defaults: this.edgeDefaults(),
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
			colorOf: (edgeIndex) => {
				if (this.edgeColors.size === 0) return null;
				const id = this.data.edges[edgeIndex]?.id;
				return id === undefined ? null : (this.edgeColors.get(id) ?? null);
			},
		};
	}

	/** Edge ID to compiled index, rebuilt only when the edge list is replaced. */
	private edgeIndicesById(): ReadonlyMap<string, number> {
		if (this.edgeIndexCache.edges !== this.data.edges) {
			const indices = new Map<string, number>();
			for (const [index, edge] of this.data.edges.entries()) indices.set(edge.id, index);
			this.edgeIndexCache = { edges: this.data.edges, indices };
		}
		return this.edgeIndexCache.indices;
	}

	/** Drops edge states whose edges left the graph. */
	private pruneEdgeStates() {
		if (this.selectedEdgeIds.size + this.dimmedEdgeIds.size + this.edgeColors.size === 0) return;
		const indices = this.edgeIndicesById();
		this.selectedEdgeIds = new Set([...this.selectedEdgeIds].filter((id) => indices.has(id)));
		this.dimmedEdgeIds = new Set([...this.dimmedEdgeIds].filter((id) => indices.has(id)));
		this.edgeColors = new Map([...this.edgeColors].filter(([id]) => indices.has(id)));
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
		if (state === "selected" && this.depthOfField.enabled) {
			const { durationMs, easing } = this.depthOfField.transition;
			this.depthOfFieldFocus.retarget(durationMs, resolveEasing(easing));
		}
		this.applySelectionColors(changedNodeIds);
		if (
			this.nodeStateRepinsEdges(
				state,
				[...changedNodeIds].filter((id) => nextSelection.has(id)),
			)
		) {
			this.syncPinnedOverlay();
		}
		this.requestRender();
		if (state === "selected" || state === "hovered") this.notifyFocusChange();
	}

	/**
	 * Selected and focused nodes pin their edges, so over the edge budget a change redraws the overlay.
	 * Hover changes constantly, so it does so only for a hovered node with an edge the last frame left out.
	 */
	private nodeStateRepinsEdges(state: GraphraumNodeState, enteredNodeIds: readonly string[]): boolean {
		if (state === "dimmed" || !this.edgeBudgetActive()) return false;
		if (state !== "hovered") return true;
		return enteredNodeIds.some((id) => {
			const nodeIndex = this.nodeIndices.get(id);
			const incident = nodeIndex === undefined ? [] : (this.incidentEdgeIndices[nodeIndex] ?? []);
			return incident.some((edgeIndex) => !this.visibleEdgeLayouts.has(edgeIndex));
		});
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
		this.nodeDrag.cancel({ restore: true });
		this.stopAutoOrbit();
		this.mode = mode;
		this.controls.removeEventListener("change", this.handleViewChange);
		this.controls.dispose();
		this.camera = this.createCamera();
		this.controls = this.createControls();
		this.applySceneDrawSetup();
		this.fitView();
	}

	/**
	 * Updates the 3D scene. Omitted fields keep their value, so `setScene({ edgeDepth: "scene" })`
	 * changes only the edge depth and `setScene({ sun: { azimuth: 90 } })` only the sun's direction.
	 * `graphraumScenes.lit` (or `flat`, `toon`) sets a whole look in one call. Shading and light are a
	 * no-op in 2D and cost no extra draw calls. Invalid options throw before anything changes, with the
	 * option path and the allowed values in the message.
	 */
	setScene(options: GraphraumSceneOptions) {
		this.scene3d = resolveSceneOptions(options, this.scene3d);
		this.applySceneDrawSetup();
		this.requestRender();
	}

	/** The scene options in effect, including defaults. */
	getScene(): ResolvedGraphraumSceneOptions {
		return this.scene3d;
	}

	/**
	 * Draws a tinted icon inside each node that has an `icon` index, from one atlas, in the same
	 * pass as the nodes (no extra draw call). Pass `null` to remove icons. The atlas comes from
	 * `createIconAtlas` in `@yggy-tech/graphraum/icons` and stays owned by the caller, who disposes
	 * its texture. Setting an atlas compiles the node shader once with the icon branch.
	 */
	setIconAtlas(atlas: GraphraumIconAtlas | null, options: GraphraumIconOptions = {}) {
		if (this.destroyed) return;
		if (atlas === null) {
			this.iconSetup = null;
		} else {
			assertIconAtlas(atlas);
			assertIconScale(options.scale);
			for (const node of this.data.nodes) assertNodeIconInAtlas(node.id, node.icon, atlas.count);
			this.iconSetup = { atlas, options: { ...options } };
		}
		this.applySceneDrawSetup();
		this.requestRender();
	}

	private assertIconsInAtlas(compiled: {
		nodeIds: readonly string[];
		nodeVisuals: readonly Readonly<{ icon?: number }>[];
	}) {
		if (!this.iconSetup) return;
		for (const [index, visual] of compiled.nodeVisuals.entries()) {
			assertNodeIconInAtlas(compiled.nodeIds[index] ?? "", visual.icon, this.iconSetup.atlas.count);
		}
	}

	private applySceneDrawSetup() {
		const setup = resolveSceneDrawSetup(this.mode, this.scene3d);
		if (this.nodeMesh && this.nodeMesh.material instanceof ShaderMaterial) {
			configureNodeMaterial(this.nodeMesh.material, {
				depth: setup.nodeDepth,
				lensDepth: this.mode === "2d" && this.focusLens.enabled,
				icons: this.iconSetup,
				shading: setup.shading,
				sphereImpostors: setup.sphereImpostors,
			});
			const { sun, sky, ground } = sceneLightColours(this.scene3d);
			setNodeLighting(this.nodeMesh.material, {
				sunDirection: sunDirection(this.scene3d.sun.azimuth, this.scene3d.sun.elevation),
				sun,
				sky,
				ground,
			});
		}
		if (this.edgeMesh && this.edgeMesh.material instanceof ShaderMaterial) {
			this.edgeMesh.material.depthTest = setup.edgeDepthTest;
			const sphereEnds = this.edgeMesh.material.uniforms.sphereEnds;
			if (sphereEnds) sphereEnds.value = setup.sphereImpostors ? 1 : 0;
			this.edgeMesh.renderOrder = setup.edgeRenderOrder;
		}
	}

	/**
	 * Updates the focus lens; omitted fields keep their value. Enabled, nodes near the center of the
	 * canvas draw larger and nodes toward its edge draw smaller, in 2D and 3D alike. Only drawn size
	 * changes, never a position. Hovered and selected nodes never draw smaller than their own size.
	 * Picking uses the drawn size. Edges meet node centers while the lens is on, and in 2D bigger nodes
	 * draw on top. Sizes ease toward their target each frame unless the viewer prefers reduced motion.
	 * Aggregated density tiers draw at their own size. Invalid options throw before anything changes.
	 */
	setFocusLens(options: GraphraumFocusLensOptions) {
		const previous = this.focusLens;
		this.focusLens = resolveFocusLensOptions(options, previous);
		if (this.destroyed) return;
		if (!this.focusLens.enabled) this.resetFocusLens();
		if (!this.nodeMesh) return;
		this.applySceneDrawSetup();
		if (previous.enabled !== this.focusLens.enabled || previous.centerScale !== this.focusLens.centerScale) {
			this.materializeViewport();
		}
		this.requestRender();
	}

	/**
	 * Turns lower quality while the camera moves on or off (default off); omitted fields keep their
	 * value. Enabled, frames of a moving camera that run slower than `targetFrameMs` step the tier
	 * down (`getDiagnostics().interactionQuality`): the render pixel ratio drops and so do the
	 * visible edge budget and, in 2D, the visible node budget (3D keeps every node, because a cut
	 * node list would drop nodes instead of thinning them). After `idleMs` without a camera change
	 * full quality returns at once. Only render resolution and budgets change, never data, and no
	 * draw call is added. Invalid options throw before anything changes.
	 */
	setInteractionQuality(options: GraphraumInteractionQualityOptions) {
		const resolved = resolveInteractionQualityOptions(options, this.interactionQuality);
		if (this.destroyed) return;
		this.interactionQuality = resolved;
		const loweredBefore = this.qualityTier !== 0;
		this.qualityGovernor?.dispose();
		this.qualityGovernor = resolved.enabled
			? new InteractionQualityGovernor(resolved, () => this.applyQualityTier())
			: null;
		if (loweredBefore) this.applyQualityTier();
	}

	private get qualityTier() {
		return this.qualityGovernor?.tier ?? 0;
	}

	private get edgeBudget() {
		return scaledBudget(this.maxVisibleEdges, this.qualityTier);
	}

	private get nodeBudget() {
		return this.mode === "2d" ? scaledBudget(this.maxVisibleNodes, this.qualityTier) : this.maxVisibleNodes;
	}

	/** Applies the tier: the pixel ratio and the budgets, in one frame. */
	private applyQualityTier() {
		this.renderer.setPixelRatio(scaledPixelRatio(this.basePixelRatio, this.qualityTier));
		// The density hysteresis would keep clusters on after the budget is back at full.
		if (this.qualityTier === 0) this.densityLodActive = false;
		this.materializeViewport();
		this.requestRender();
	}

	/** The focus lens options in effect, including defaults. */
	getFocusLens(): ResolvedFocusLensOptions {
		return this.focusLens;
	}

	/**
	 * Opacity, 0 to 1, a host should give a node's label under the focus lens: only nodes drawn large
	 * show one. Hovered and selected nodes are always 1, as is every node while the lens is off.
	 * `GraphraumOverlay` applies it to its labels; hosts with their own labels can read it from a view
	 * listener.
	 */
	getFocusLensLabelAlpha(nodeId: string): number {
		if (!this.focusLens.enabled || !this.lensApplied) return 1;
		if (this.hoveredNodeIds.has(nodeId) || this.selectedNodeIds.has(nodeId)) return 1;
		const index = this.nodeIndices.get(nodeId);
		const scale = index === undefined ? 0 : (this.lensScales[index] ?? 0);
		return scale === 0 ? 1 : focusLensLabelAlpha(scale, this.focusLens);
	}

	/** Edges meet node centers under the lens, because the drawn outline moves each frame. */
	private endpointAttach() {
		return this.focusLens.enabled ? "center" : this.theme.endpointAttach;
	}

	/** How much larger than a node's own size its 3D pick proxy must be to cover the lens. */
	private lensPickGrowth() {
		return this.focusLens.enabled ? Math.max(1, this.focusLens.centerScale) : 1;
	}

	private lensScaleOf(nodeIndex: number) {
		return this.lensApplied ? (this.lensScales[nodeIndex] ?? 0) || 1 : 1;
	}

	private resetFocusLens() {
		this.lensScales.fill(0);
		if (!this.lensApplied) return;
		this.lensApplied = false;
		const attribute = this.nodeMesh?.geometry.getAttribute("instanceLens") as InstancedBufferAttribute | undefined;
		if (!attribute) return;
		(attribute.array as Float32Array).fill(1);
		attribute.clearUpdateRanges();
		attribute.needsUpdate = true;
		if (this.hasGlowNodes) this.glowLayer.rewrite(this.describeGlowNode);
	}

	/**
	 * Moves every drawn node's lens size one frame toward its target and writes it to the GPU. Runs
	 * before each frame; allocates nothing. Asks for another frame until all sizes have settled.
	 */
	private updateFocusLens() {
		const options = this.focusLens;
		if (!options.enabled || this.densityLodActive || !this.nodeMesh) {
			if (this.lensApplied) this.resetFocusLens();
			return;
		}
		const attribute = this.nodeMesh.geometry.getAttribute("instanceLens") as InstancedBufferAttribute;
		const values = attribute.array as Float32Array;
		if (this.lensScales.length < this.data.nodes.length) {
			const grown = new Float32Array(Math.max(this.data.nodes.length, this.lensScales.length * 2));
			grown.set(this.lensScales);
			this.lensScales = grown;
		}
		const scales = this.lensScales;
		const width = this.canvasWidth;
		const height = this.canvasHeight;
		const viewportMin = Math.min(width, height);
		this.camera.updateMatrixWorld();
		this.lensMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
		const m = this.lensMatrix.elements;
		const instant = prefersReducedMotion();
		const hasFocus = this.hoveredNodeIds.size > 0 || this.selectedNodeIds.size > 0;
		const indices = this.visibleNodeIndices;
		const count = Math.min(indices.length, values.length);
		let unsettled = false;
		for (let slot = 0; slot < count; slot += 1) {
			const nodeIndex = indices[slot] as number;
			const node = this.data.nodes[nodeIndex];
			if (!node) continue;
			const x = node.position.x;
			const y = node.position.y;
			const z = node.position.z ?? 0;
			const w = m[3] * x + m[7] * y + m[11] * z + m[15];
			let distance = Number.POSITIVE_INFINITY;
			if (w > 1e-9) {
				const px = (((m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * width) / 2;
				const py = (((m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * height) / 2;
				distance = Math.hypot(px, py);
			}
			let target = focusLensScale(distance, viewportMin, options);
			if (hasFocus && target < 1 && (this.hoveredNodeIds.has(node.id) || this.selectedNodeIds.has(node.id))) {
				target = 1;
			}
			const shown = scales[nodeIndex] as number;
			let next = target;
			if (shown !== 0 && !instant) {
				next = shown + (target - shown) * options.easing;
				if (Math.abs(target - next) < LENS_SETTLE_EPSILON) next = target;
				else unsettled = true;
			}
			scales[nodeIndex] = next;
			values[slot] = next;
		}
		attribute.clearUpdateRanges();
		attribute.addUpdateRange(0, count);
		attribute.needsUpdate = true;
		this.lensApplied = true;
		if (this.hasGlowNodes) this.glowLayer.rewrite(this.describeGlowNode);
		if (unsettled) this.requestRender();
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

	/**
	 * Updates 3D depth of field; omitted fields keep their current values. Enabling, disabling and a
	 * new `strength` fade the blur over `transition` unless `update.animate` is `false`; a change
	 * during a fade continues from the blur shown last. With `focus: "selection"` the focal plane
	 * follows the mean position of the selected nodes, re-measured from the camera every frame, and
	 * moves over `transition` when the selection changes; with nothing selected the blur fades out.
	 * `prefers-reduced-motion: reduce` jumps. Resolves `true` when the blur reaches the new strength
	 * and `false` when a later call or `destroy()` interrupts the fade. While it blurs each frame adds
	 * four draw calls; disabled, or with nothing to blur, it costs nothing. The `"depth"` mode is a
	 * no-op in 2D. `mode: "radial"` keeps the selection and its neighbours crisp and blurs the rest by
	 * screen distance from the selection, in 2D and 3D, with an optional `vignette`; switching `mode`
	 * live swaps the effect. Picking and DOM overlays are unaffected. Throws for invalid values.
	 */
	setDepthOfField(options: GraphraumDepthOfFieldOptions, update: GraphraumDepthOfFieldUpdate = {}): Promise<boolean> {
		const animate = update.animate ?? true;
		if (typeof animate !== "boolean") {
			throw new Error(`setDepthOfField option animate must be a boolean; received ${String(animate)}.`);
		}
		const previous = this.depthOfField;
		this.depthOfField = resolveDepthOfFieldOptions(options, previous);
		if (this.destroyed) return Promise.resolve(false);
		const { durationMs, easing } = this.depthOfField.transition;
		// The strength fade carries the fade-in, so the focus starts on the selection.
		if (this.depthOfField.enabled && !previous.enabled) this.depthOfFieldFocus.retarget(0, resolveEasing(easing));
		const fadeMs = animate && !prefersReducedMotion() ? durationMs : 0;
		const done = this.depthOfFieldStrength.retarget(this.depthOfFieldTargetStrength(), fadeMs, resolveEasing(easing));
		void this.depthOfFieldNearStrength.retarget(this.depthOfFieldTargetNearStrength(), fadeMs, resolveEasing(easing));
		this.requestRender();
		return done;
	}

	private depthOfFieldTargetStrength() {
		const { enabled, mode, strength } = this.depthOfField;
		if (!enabled) return 0;
		// Radial mode fades its whole effect in and out; the strength only scales depth of field.
		return mode === "radial" ? 1 : strength;
	}

	private depthOfFieldTargetNearStrength() {
		const { enabled, nearStrength, strength } = this.depthOfField;
		return enabled ? (nearStrength ?? strength) : 0;
	}

	getNodePresentation(nodeId: string): CompiledGraphraumPresentation | null {
		return this.nodePresentations.get(nodeId) ?? null;
	}

	/** Returns canvas-relative screen coordinates for a node, or null when the node does not exist. */
	getNodeScreenPosition(nodeId: string): GraphraumScreenPosition | null {
		const index = this.nodeIndices.get(nodeId);
		const node = index === undefined ? undefined : this.data.nodes[index];
		if (!node) return null;
		const center = new Vector3(node.position.x, node.position.y, node.position.z ?? 0);
		const projected = center.clone().project(this.camera);
		const width = this.renderer.domElement.clientWidth;
		const height = this.renderer.domElement.clientHeight;
		// The drawn radius: one node radius along the camera's up axis, projected like the centre.
		const axes = resolveNodeAxes({ height: node.height, nodeId: node.id, size: node.size, width: node.width });
		const rim = center
			.add(
				new Vector3(0, Math.max(axes.width, axes.height) * this.lensScaleOf(index as number), 0).applyQuaternion(
					this.camera.quaternion,
				),
			)
			.project(this.camera);
		return {
			radius: Math.hypot(((rim.x - projected.x) * width) / 2, ((rim.y - projected.y) * height) / 2),
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

	/**
	 * Turns node dragging on or off (default off). A drag starts when the pointer moves past a small
	 * tolerance after a press on a node (a finger must rest on the node first, so a swipe still pans
	 * the camera), moves the node on a plane facing the camera, and ends on release. Escape or a
	 * cancelled pointer put the node back. Not available while the density LOD shows clusters.
	 */
	setNodeDrag(options: GraphraumNodeDragOptions) {
		if (typeof options?.enabled !== "boolean") throw new Error("setNodeDrag option enabled must be a boolean.");
		this.nodeDrag.setEnabled(options.enabled);
	}

	/** Subscribes to node drag steps (`start`, `move`, `end`, `cancel`). Returns an unsubscribe function. */
	onNodeDrag(listener: (event: GraphraumNodeDragEvent) => void) {
		this.nodeDragListeners.add(listener);
		return () => this.nodeDragListeners.delete(listener);
	}

	private createNodeDragHost() {
		const element = this.renderer.domElement;
		return {
			canStart: () => !this.destroyed && this.nodeMesh !== null && !this.densityLodActive,
			createSurface: (anchor: GraphraumPosition) =>
				createNodeDragSurface({
					anchor,
					bounds: () => element.getBoundingClientRect(),
					camera: this.camera,
					raycaster: this.raycaster,
				}),
			document: element.ownerDocument,
			element,
			emit: (event: GraphraumNodeDragEvent) => {
				for (const listener of this.nodeDragListeners) listener(event);
			},
			moveNode: (nodeId: string, position: GraphraumPosition) => this.updateNodes([{ id: nodeId, position }]),
			nodePosition: (nodeId: string) => {
				const index = this.nodeIndices.get(nodeId);
				const node = index === undefined ? undefined : this.data.nodes[index];
				return node ? { ...node.position } : null;
			},
			pickNode: (clientX: number, clientY: number) => this.pickNode(clientX, clientY),
			setControlsEnabled: (enabled: boolean) => {
				this.controls.enabled = enabled;
			},
		};
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
		if (this.nodeDrag.active) return;
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
			depthOfField: this.depthOfFieldStatus,
			edgeDepth: resolveSceneDrawSetup(this.mode, this.scene3d).edgeDepthTest ? "scene" : "behind-nodes",
			shading: resolveSceneDrawSetup(this.mode, this.scene3d).shading,
			gpuFrameMilliseconds: this.gpuFrameMilliseconds,
			gpuDrawCalls: this.renderer.info.render.calls,
			gpuGeometries: this.renderer.info.memory.geometries,
			gpuTextures: this.renderer.info.memory.textures,
			interactionQuality: INTERACTION_TIERS[this.qualityTier]?.name ?? "full",
			lodLevel: resolveLodLevel(this.densityLodActive, this.visibleEdgeCandidateCount, this.visibleEdgeCount),
			pickingStrategy: this.mode === "2d" ? "spatial-grid-2d" : "raycaster-3d",
			coloredEdges: this.edgeColors.size,
			dimmedEdges: this.dimmedEdgeIds.size,
			selectedEdges: this.selectedEdgeIds.size,
			selectedNodes: this.selectedNodeIds.size,
			subPixelEdgesSkipped: this.subPixelEdgesSkipped,
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
		// The full pass below packs the new view, so the change event must not pack it a second time.
		this.orbitUpdating = true;
		try {
			this.controls.update();
		} finally {
			this.orbitUpdating = false;
		}
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
				if (this.mode === "2d") this.materializeViewport(false, true);
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

	setStyle(style: GraphraumStyleInput) {
		this.mergeStyle(style);
		this.setTheme({});
	}

	private mergeStyle(style: GraphraumStyleInput) {
		const extras = resolveStyleExtras(style, this.extras);
		if (style.theme) this.theme = resolveGraphraumTheme(style.theme, this.theme);
		this.extras = extras;
		applyLabelVariables(this.container, extras.label);
	}

	private edgeDefaults() {
		const { edge, edgeOpacity, edgeWidth } = this.theme;
		return { color: edge, markerSize: this.extras.edge.markerSize, opacity: edgeOpacity, width: edgeWidth };
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
		// The same size packs the same view; only a new size changes what the camera frames.
		if (sizeChanged) this.materializeViewport();
		this.requestRender();
	}

	destroy() {
		this.destroyed = true;
		this.cancelFlight();
		this.nodeDrag.dispose();
		this.stopAutoOrbit();
		this.qualityGovernor?.dispose();
		this.qualityGovernor = null;
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
		this.depthOfFieldStrength.cancel();
		this.depthOfFieldNearStrength.cancel();
		this.disposeDepthOfFieldPass();
		this.disposeRadialFocusPass();
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
		this.qualityGovernor?.frame();
		this.updateFocusLens();
		this.readGpuTimers();
		const timer = this.gpuTimer;
		const query = timer?.context.createQuery() ?? null;
		if (timer && query) timer.context.beginQuery(timer.extension.TIME_ELAPSED_EXT, query);
		const startedAt = performance.now();
		const radial = this.depthOfField.mode === "radial";
		const radialFocus = radial ? this.prepareRadialFocus(startedAt) : null;
		const depthOfField = radial ? null : this.prepareDepthOfField(startedAt);
		// Only the pass of the current mode keeps its render targets.
		if (radial) this.disposeDepthOfFieldPass();
		else this.disposeRadialFocusPass();
		if (radialFocus && this.radialFocusPass) {
			this.renderer.info.autoReset = false;
			this.renderer.info.reset();
			try {
				this.radialFocusPass.render(this.renderer, this.scene, this.radialCrispScene(), this.camera, radialFocus);
			} finally {
				this.renderer.info.autoReset = true;
			}
		} else if (depthOfField && this.depthOfFieldPass && this.camera instanceof PerspectiveCamera) {
			// Several render calls make one frame; count them together so gpuDrawCalls stays per frame.
			this.renderer.info.autoReset = false;
			this.renderer.info.reset();
			try {
				this.depthOfFieldPass.render(this.renderer, this.scene, this.camera, this.edgeMesh, depthOfField);
			} finally {
				this.renderer.info.autoReset = true;
			}
		} else {
			this.renderer.render(this.scene, this.camera);
		}
		this.cpuFrameMilliseconds = performance.now() - startedAt;
		if (timer && query) {
			timer.context.endQuery(timer.extension.TIME_ELAPSED_EXT);
			timer.pending.push(query);
		}
		for (const listener of this.viewListeners) listener();
	}

	/**
	 * Decides whether this frame blurs and records why in the diagnostics status. Returns null to
	 * render directly. Requests another frame while a fade or focus move runs; both end on their own.
	 */
	private prepareDepthOfField(nowMs: number): DepthOfFieldFrame | null {
		const options = this.depthOfField;
		const strengthTween = this.depthOfFieldStrength;
		const nearStrengthTween = this.depthOfFieldNearStrength;
		if (!options.enabled && strengthTween.settled && nearStrengthTween.settled) {
			this.depthOfFieldStatus = "off";
			this.disposeDepthOfFieldPass();
			return null;
		}
		if (!(this.camera instanceof PerspectiveCamera)) {
			strengthTween.jump();
			nearStrengthTween.jump();
			this.depthOfFieldStatus = options.enabled ? "inactive" : "off";
			this.disposeDepthOfFieldPass();
			return null;
		}
		if (!DepthOfFieldPass.isSupported(this.renderer)) {
			strengthTween.jump();
			nearStrengthTween.jump();
			this.depthOfFieldStatus = options.enabled ? "unsupported" : "off";
			if (options.enabled && !warnedDepthOfFieldUnsupported) {
				warnedDepthOfFieldUnsupported = true;
				console.warn(
					'graphraum: depth of field needs a WebGL 2 context and is turned off for this canvas. getDiagnostics().depthOfField reports "unsupported".',
				);
			}
			return null;
		}
		const strength = strengthTween.sample(nowMs);
		const nearStrength = nearStrengthTween.sample(nowMs);
		if (!strengthTween.settled || !nearStrengthTween.settled) this.requestRender();
		this.camera.updateMatrixWorld();
		let focusDistance: number | null = typeof options.focus === "number" ? options.focus : null;
		let amount = 1;
		if (options.focus === "selection") {
			const focus = this.depthOfFieldFocus.evaluate(nowMs, this.selectionFocusPoint(), prefersReducedMotion());
			if (!focus.settled) this.requestRender();
			amount = focus.amount;
			if (focus.point) focusDistance = viewDistance(focus.point, this.camera.matrixWorldInverse.elements);
		}
		if (focusDistance === null) {
			this.depthOfFieldStatus = options.enabled ? "inactive" : "off";
			return null;
		}
		focusDistance = Math.max(focusDistance, this.camera.near);
		const pixelRatio = this.renderer.getPixelRatio();
		const pixelsPerStrength =
			amount *
			distanceFade(focusDistance, options.nearDistance, options.farDistance) *
			DEPTH_OF_FIELD_APERTURE_CSS_PIXELS *
			pixelRatio;
		const aperturePixels = strength * pixelsPerStrength;
		const nearAperturePixels = nearStrength * pixelsPerStrength;
		const maxBlurPixels = options.maxBlur * pixelRatio;
		if (
			Math.max(aperturePixels, nearAperturePixels) < DEPTH_OF_FIELD_MIN_BLUR_PIXELS ||
			maxBlurPixels < DEPTH_OF_FIELD_MIN_BLUR_PIXELS
		) {
			this.depthOfFieldStatus = options.enabled ? "inactive" : "off";
			return null;
		}
		this.depthOfFieldPass ??= new DepthOfFieldPass(this.antialias);
		this.depthOfFieldStatus = "active";
		return {
			aperturePixels,
			focusDistance,
			maxBlurPixels,
			minBlurPixels: options.minBlur * pixelRatio,
			nearAperturePixels,
		};
	}

	/** Mean world position of the selected nodes, read every frame so a running layout keeps them in focus. */
	private selectionFocusPoint(): FocusPoint | null {
		return meanPoint(
			[...this.selectedNodeIds].flatMap((id) => {
				const index = this.nodeIndices.get(id);
				const node = index === undefined ? undefined : this.data.nodes[index];
				return node ? [{ x: node.position.x, y: node.position.y, z: node.position.z ?? 0 }] : [];
			}),
		);
	}

	/**
	 * Decides whether this frame runs the radial focus and records why in the diagnostics status.
	 * Mirrors `prepareDepthOfField`: a fade or focus move requests more frames and ends on its own.
	 */
	private prepareRadialFocus(nowMs: number): RadialFocusFrame | null {
		const options = this.depthOfField;
		const fadeTween = this.depthOfFieldStrength;
		const nearTween = this.depthOfFieldNearStrength;
		if (!options.enabled && fadeTween.settled && nearTween.settled) {
			this.depthOfFieldStatus = "off";
			this.disposeRadialFocusPass();
			return null;
		}
		if (!RadialFocusPass.isSupported(this.renderer)) {
			fadeTween.jump();
			nearTween.jump();
			this.depthOfFieldStatus = options.enabled ? "unsupported" : "off";
			if (options.enabled && !warnedDepthOfFieldUnsupported) {
				warnedDepthOfFieldUnsupported = true;
				console.warn(
					'graphraum: the radial focus needs a WebGL 2 context and is turned off for this canvas. getDiagnostics().depthOfField reports "unsupported".',
				);
			}
			return null;
		}
		const fade = fadeTween.sample(nowMs);
		nearTween.sample(nowMs);
		if (!fadeTween.settled || !nearTween.settled) this.requestRender();
		this.camera.updateMatrixWorld();
		const focus = this.depthOfFieldFocus.evaluate(nowMs, this.selectionFocusPoint(), prefersReducedMotion());
		if (!focus.settled) this.requestRender();
		const amount = fade * focus.amount;
		const maxBlurPixels = options.maxBlur * this.renderer.getPixelRatio();
		if (!focus.point || amount * maxBlurPixels < RADIAL_MIN_BLUR_PIXELS) {
			this.depthOfFieldStatus = options.enabled ? "inactive" : "off";
			return null;
		}
		const { x: width, y: height } = this.renderer.getDrawingBufferSize(new Vector2());
		const ndc = new Vector3(focus.point.x, focus.point.y, focus.point.z).project(this.camera);
		this.radialFocusPass ??= new RadialFocusPass(this.antialias);
		this.depthOfFieldStatus = "active";
		return {
			amount,
			focusX: (ndc.x * 0.5 + 0.5) * width,
			focusY: (ndc.y * 0.5 + 0.5) * height,
			innerPixels: options.innerRadius * height,
			maxBlurPixels,
			outerPixels: options.outerRadius * height,
			vignette: options.vignette ? options.vignetteStrength * amount : 0,
			vignetteTone: vignetteTone(this.solidBackground()),
		};
	}

	/** The theme background when it is a plain colour; `null` for transparent and image backgrounds. */
	private solidBackground(): string | null {
		const background = normalizeGraphraumBackground(this.theme.background);
		return typeof background === "string" ? background : null;
	}

	/**
	 * Rewrites the crisp meshes for this frame: the selected, focused and hovered nodes, their one-hop
	 * neighbours and the edges between them. Null when nothing is selected or the nodes are aggregated.
	 */
	private radialCrispScene(): Scene | null {
		const { nodeMesh } = this;
		if (!nodeMesh || !this.nodeSlotsPlain) return null;
		const toIndices = (ids: Iterable<string>) =>
			[...ids].flatMap((id) => {
				const index = this.nodeIndices.get(id);
				return index === undefined ? [] : [index];
			});
		const expanding = toIndices([...this.selectedNodeIds, ...this.focusedNodeIds]);
		const anchors = [...expanding, ...toIndices(this.hoveredNodeIds)];
		if (anchors.length === 0) return null;
		const crispNodes = crispNodeIndices(anchors, expanding, (index) =>
			(this.incidentEdgeIndices[index] ?? []).flatMap((edgeIndex) => {
				const source = this.edgeNodeIndices[edgeIndex * 2];
				const target = this.edgeNodeIndices[edgeIndex * 2 + 1];
				const other = source === index ? target : source;
				return other === undefined ? [] : [other];
			}),
		);
		const edgeIndices = this.selectedEdgeIds.size > 0 ? this.edgeIndicesById() : null;
		const crispEdges = crispEdgeIndices(
			crispNodes,
			(index) => this.incidentEdgeIndices[index] ?? [],
			this.edgeNodeIndices,
			[...this.selectedEdgeIds].flatMap((id) => {
				const edgeIndex = edgeIndices?.get(id);
				return edgeIndex === undefined ? [] : [edgeIndex];
			}),
		);
		const layer = this.radialCrispLayer ?? new RadialCrispLayer();
		this.radialCrispLayer = layer;
		layer.sync(
			{ edgeMesh: this.edgeMesh, nodeMesh },
			[...crispNodes].flatMap((index) => {
				const slot = this.visibleNodeSlot(index);
				return slot === undefined ? [] : [slot];
			}),
			[...crispEdges].flatMap((edgeIndex) => {
				const layout = this.visibleEdgeLayouts.get(edgeIndex);
				return layout ? [layout] : [];
			}),
		);
		return layer.scene;
	}

	private disposeRadialFocusPass() {
		this.radialFocusPass?.dispose();
		this.radialFocusPass = null;
		this.radialCrispLayer?.dispose();
		this.radialCrispLayer = null;
	}

	private disposeDepthOfFieldPass() {
		this.depthOfFieldPass?.dispose();
		this.depthOfFieldPass = null;
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
		// The camera stays put while a node follows the pointer.
		if (this.nodeDrag.active) return;
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
		this.qualityGovernor?.motion();
		if (!this.orbitUpdating) this.materializeViewport(false, true);
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

	/** Points the pick ray at the client position; false while the canvas has no size. */
	private aimPointer(clientX: number, clientY: number) {
		const bounds = this.renderer.domElement.getBoundingClientRect();
		if (bounds.width === 0 || bounds.height === 0) return false;
		this.pointer.set(
			((clientX - bounds.left) / bounds.width) * 2 - 1,
			-((clientY - bounds.top) / bounds.height) * 2 + 1,
		);
		return true;
	}

	private pickNode(clientX: number, clientY: number): string | null {
		if (!this.nodeMesh || !this.nodePickMesh) return null;
		if (!this.aimPointer(clientX, clientY)) return null;
		if (this.camera instanceof OrthographicCamera) {
			const world = new Vector3(this.pointer.x, this.pointer.y, 0).unproject(this.camera);
			const index = this.focusLens.enabled
				? this.spatialGrid2d.pick(world.x, world.y, this.lensScales, this.focusLens.centerScale)
				: this.spatialGrid2d.pick(world.x, world.y);
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
			const lens = this.lensScaleOf(nodeIndex);
			this.pickRight
				.set(1, 0, 0)
				.applyQuaternion(this.camera.quaternion)
				.multiplyScalar(width * lens);
			this.pickRight.set(
				this.pickRight.x + node.position.x,
				this.pickRight.y + node.position.y,
				this.pickRight.z + (node.position.z ?? 0),
			);
			this.pickRight.project(this.camera);
			this.pickUp
				.set(0, 1, 0)
				.applyQuaternion(this.camera.quaternion)
				.multiplyScalar(height * lens);
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
		if (!this.edgeMesh || this.visibleEdgeSegmentCount === 0) return null;
		if (!this.aimPointer(clientX, clientY)) return null;
		if (this.camera instanceof OrthographicCamera) {
			const world = new Vector3(this.pointer.x, this.pointer.y, 0).unproject(this.camera);
			const edgeIndex = pickClosestEdgeIndex(
				{ x: world.x, y: world.y },
				this.pickableEdgeSegments,
				this.worldUnitsPerPixel(),
			);
			return edgeIndex === null ? null : (this.data.edges[edgeIndex]?.id ?? null);
		}
		this.raycaster.setFromCamera(this.pointer, this.camera);
		for (const hit of this.raycaster.intersectObject(this.edgeMesh, false)) {
			if (hit.instanceId === undefined) continue;
			if (hit.instanceId >= this.visibleEdgeSegmentEdgeIndices.length) continue;
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
			const slot = this.visibleNodeSlot(index);
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
		target.extent = Math.max(width, height) * this.lensScaleOf(nodeIndex);
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

	/** The node's display color in a scratch `Color` that the next call overwrites: copy it out at once. */
	private getNodeColor(node: GraphraumData<NodeAttributes, EdgeAttributes>["nodes"][number]) {
		const source = this.focusedNodeIds.has(node.id)
			? this.theme.focusedNode
			: this.selectedNodeIds.has(node.id)
				? this.theme.selectedNode
				: this.hoveredNodeIds.has(node.id)
					? this.theme.hoveredNode
					: this.dimmedNodeIds.has(node.id)
						? this.theme.dimmedNode
						: (node.color ?? this.theme.node);
		return this.resolveColor(source);
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

	/**
	 * `pinnedInMain` is the fallback when the overlay does not fit: pinned edges then take budget slots.
	 * `cameraMoved` means only the camera changed, so nodes that stay in view keep their instances.
	 */
	private materializeViewport(pinnedInMain = false, cameraMoved = false) {
		if (!this.nodeMesh || !this.nodePickMesh || !this.edgeMesh) return;
		const bounds = this.getViewportBounds2d();
		const visibleNodeCandidates = bounds
			? this.spatialGrid2d.queryBounds(bounds, this.viewportOverscan)
			: this.data.nodes.map((_, index) => index);
		this.densityLodActive = shouldUseDensityLod(visibleNodeCandidates.length, this.nodeBudget, this.densityLodActive);
		// Instances are reused only where a full pass would also draw every candidate as itself, in
		// any order: no density tier, no node budget cut, no focus lens moving instances per frame.
		const reuseSlots =
			cameraMoved &&
			bounds !== null &&
			this.nodeSlotsPlain &&
			!this.densityLodActive &&
			!this.focusLens.enabled &&
			visibleNodeCandidates.length <= this.nodeBudget;
		const materializedNodes = reuseSlots ? [] : this.materializeNodes(visibleNodeCandidates, bounds);
		const nodeDelta = reuseSlots ? this.patchNodeSlots(visibleNodeCandidates) : null;
		const visibleNodeIndices = nodeDelta ? nodeDelta.indices : materializedNodes.map(({ index }) => index);
		if (!nodeDelta) this.edgeVisibility.live = false;
		if (!(nodeDelta && this.patchEdgeSlots(nodeDelta))) {
			const edgeCandidates = bounds
				? // Candidate order, not slot order, so the edges pack as a full pass would.
					collectIncidentEdges(
						reuseSlots ? visibleNodeCandidates : visibleNodeIndices,
						this.incidentEdgeIndices,
						this.data.edges.length,
					)
				: this.data.edges.map((_, index) => index);
			const { skippedSubPixel, visibleEdgeIndices } = this.budgetEdges(edgeCandidates, pinnedInMain);
			if (!reuseSlots) this.writeAllNodeInstances(materializedNodes, visibleNodeIndices);

			const lodLevel = resolveLodLevel(this.densityLodActive, edgeCandidates.length, visibleEdgeIndices.length);
			this.lastEdgeLodTier = edgeTierFromDiagnosticsLod(lodLevel);
			const packed = this.packEdges(visibleEdgeIndices, this.edgeSegmentCapacity);
			this.visibleEdgeLayouts = buildVisibleEdgeLayouts(packed.segments, packed.markers, packed.segments.length);
			this.pickableEdgeSegments = [];
			this.visibleEdgeSegmentEdgeIndices = [];
			this.fitEdgeInstances(packed.segments.length + packed.markers.length);
			const distinctEdgeCount = this.writeEdgeInstances(packed, {
				markerStart: packed.segments.length,
				segmentStart: 0,
			});
			const segmentCount = packed.segments.length;
			const edgeSlot = segmentCount + packed.markers.length;
			this.edgeMesh.count = edgeSlot;
			this.markEdgeInstances(0, edgeSlot, true);

			this.visibleEdgeCandidateCount = edgeCandidates.length;
			this.subPixelEdgesSkipped = skippedSubPixel;
			this.visibleEdgeSegmentCount = segmentCount;
			this.visibleEdgeCount = distinctEdgeCount;
			this.visibleEdgeMarkerCount = packed.markers.length;
			this.mainEdge = {
				edges: distinctEdgeCount,
				extent: edgeSlot,
				markers: packed.markers.length,
				segments: segmentCount,
				subPixelSkipped: skippedSubPixel,
			};
			// Only a camera move looks at the pool, and only after it kept the nodes' slots; the detail
			// tier means no density tier and no edge cut, so every candidate edge is drawn.
			this.edgePoolLive = bounds !== null && !packed.truncated && this.lastEdgeLodTier === "detail";
			if (this.edgePoolLive) {
				if (!this.edgeVisibility.live) {
					this.edgeVisibility.reset(visibleNodeIndices, this.incidentEdgeIndices, this.data.edges.length);
				}
				this.edgePool.reset(edgeSlot, this.edgePoolCapacity);
			}
			this.overlayEdgeIndices = [];
		}
		this.visibleNodeCandidateCount = visibleNodeCandidates.length;
		this.visibleNodeCount = visibleNodeIndices.length;
		if (!pinnedInMain && !this.drawPinnedOverlay()) {
			this.materializeViewport(true);
			return;
		}
		this.syncGlow();
	}

	/**
	 * Fits the incident edges to the budget. Over the budget, 2D first drops edges shorter than
	 * `SUB_PIXEL_EDGE_PIXELS` on screen (the focus lens moves endpoints, so it keeps them), then keeps
	 * pinned edges and the highest endpoint degree. 3D does not repack on orbit, so it has no screen
	 * length to cut by. The order never depends on the selection (the overlay draws what it pins),
	 * except in the `pinnedInMain` fallback.
	 */
	private budgetEdges(edgeCandidates: readonly number[], pinnedInMain: boolean) {
		if (edgeCandidates.length <= this.edgeBudget) {
			return { skippedSubPixel: 0, visibleEdgeIndices: edgeCandidates };
		}
		const pinned = pinnedInMain ? this.pinnedEdgeIndices() : NO_PINNED_EDGES;
		const cut =
			this.mode === "2d" && !this.lensApplied
				? dropSubPixelEdges(
						edgeCandidates,
						this.canonicalEdgePositions,
						this.worldUnitsPerPixel(),
						SUB_PIXEL_EDGE_PIXELS,
						pinned,
					)
				: { kept: edgeCandidates, skipped: 0 };
		return {
			skippedSubPixel: cut.skipped,
			visibleEdgeIndices: applyEdgeBudget(cut.kept, this.edgeBudget, {
				pinned,
				score: endpointDegreeScore(this.edgeNodeIndices, this.incidentEdgeIndices),
			}),
		};
	}

	/**
	 * A camera move that kept the nodes' instances keeps the edges' too: the edges of entering nodes
	 * take free runs, the ones that lost their last drawn node free theirs, and the rest stay where
	 * they are. It holds while every candidate edge fits the budget, so no edge is cut by length or
	 * rank and the set is the one a full pass draws; zooming then changes nothing but the pick radius.
	 * Slot order is no longer the candidate order of a full pass, so only the paint order of
	 * overlapping edges, and of arrowheads against other lines, can differ. Returns false, with the
	 * main layer left for a full pass to write, when the budget binds, the runs do not fit, or too
	 * many holes are left.
	 */
	private patchEdgeSlots(delta: { entering: number[]; leaving: number[] }) {
		const { edgeMesh, edgePool, edgeVisibility } = this;
		if (!edgeMesh || !edgeVisibility.live) return false;
		const entered = edgeVisibility.shift(delta.entering, 1, this.incidentEdgeIndices);
		const left = edgeVisibility.shift(delta.leaving, -1, this.incidentEdgeIndices);
		const candidates = this.visibleEdgeCandidateCount + entered.length - left.length;
		const fits = this.edgePoolLive && candidates <= this.edgeBudget;
		this.edgePoolLive = false;
		if (!fits) return false;

		const geometry = edgeMesh.geometry;
		const color = getInstancedAttribute(geometry, "instanceColor");
		const pickable = this.pickableEdgeSegments;
		const main = this.mainEdge;
		const account = (layout: VisibleEdgeLayout, sign: 1 | -1) => {
			main.segments += sign * layout.segmentCount;
			main.markers += sign * layout.markerCount;
			main.edges += sign;
		};
		for (const edgeIndex of left) {
			const layout = this.visibleEdgeLayouts.get(edgeIndex);
			if (!layout) continue;
			for (const [start, size] of [
				[layout.segmentStart, layout.segmentCount],
				[layout.markerStart, layout.markerCount],
			] as const) {
				if (size === 0) continue;
				edgePool.release(start, size);
				for (let slot = start; slot < start + size; slot += 1) {
					color.setW(slot, 0);
					Reflect.deleteProperty(pickable, slot); // a hole: picking skips it
				}
			}
			this.visibleEdgeLayouts.delete(edgeIndex);
			account(layout, -1);
		}
		if (edgePool.freeSlots > edgePool.extent / 2) return false;

		for (const edgeIndex of entered) {
			const packed = this.packEdges([edgeIndex]);
			const segmentCount = packed.segments.length;
			const markerCount = packed.markers.length;
			const markerStart = edgePool.take(markerCount);
			const segmentStart = edgePool.take(segmentCount);
			if (markerStart < 0 || segmentStart < 0) return false;
			this.writeEdgeInstances(packed, { markerStart, segmentStart });
			const layout = { markerCount, markerStart, segmentCount, segmentStart };
			this.visibleEdgeLayouts.set(edgeIndex, layout);
			account(layout, 1);
		}

		// One span: ranges are a GPU call each, and a pan frees and takes slots all over.
		if (entered.length + left.length > 0) this.markEdgeInstances(0, edgePool.extent, false);
		edgeMesh.count = edgePool.extent;
		main.extent = edgePool.extent;
		this.edgePoolLive = true;
		this.visibleEdgeCandidateCount = candidates;
		return true;
	}

	private syncPinnedOverlay() {
		if (!this.drawPinnedOverlay()) this.materializeViewport(true);
	}

	/**
	 * Replaces the overlay: the pinned edges the budgeted layer left out, written after it in their
	 * own instance range, so a selection change touches a handful of slots instead of repacking the
	 * layer. Returns false, with the overlay not drawn, when it does not fit the spare instances.
	 */
	private drawPinnedOverlay(): boolean {
		const { edgeMesh } = this;
		if (!edgeMesh) return true;
		const main = this.mainEdge;
		for (const edgeIndex of this.overlayEdgeIndices) {
			this.visibleEdgeLayouts.delete(edgeIndex);
		}
		// Overlay entries sit past the main ones; segments are listed by slot, markers leave gaps.
		this.pickableEdgeSegments.length = Math.min(this.pickableEdgeSegments.length, main.extent);
		this.visibleEdgeSegmentEdgeIndices.length = Math.min(this.visibleEdgeSegmentEdgeIndices.length, main.extent);
		const bounds = this.getViewportBounds2d();
		const onScreen = (edgeIndex: number) =>
			bounds === null ||
			this.visibleNodeSlot(this.edgeNodeIndices[edgeIndex * 2] ?? -1) !== undefined ||
			this.visibleNodeSlot(this.edgeNodeIndices[edgeIndex * 2 + 1] ?? -1) !== undefined;
		const overlay = this.edgeBudgetActive()
			? [...this.pinnedEdgeIndices()]
					.filter((edgeIndex) => !this.visibleEdgeLayouts.has(edgeIndex) && onScreen(edgeIndex))
					.sort((a, b) => a - b)
			: [];
		const start = main.extent;
		const packed = this.packEdges(overlay, this.edgeInstanceCapacity - start);
		const segmentCount = packed.segments.length;
		const markerCount = packed.markers.length;
		this.overlayEdgeIndices = [];
		if (packed.truncated || start + segmentCount + markerCount > this.edgeInstanceCapacity) return false;

		if (segmentCount > 0) {
			this.visibleEdgeSegmentEdgeIndices.length = start;
		}
		const distinct = this.writeEdgeInstances(packed, { markerStart: start + segmentCount, segmentStart: start });
		for (const [edgeIndex, layout] of buildVisibleEdgeLayouts(packed.segments, packed.markers, segmentCount)) {
			if (layout.segmentStart >= 0) layout.segmentStart += start;
			layout.markerStart += start;
			this.visibleEdgeLayouts.set(edgeIndex, layout);
		}
		edgeMesh.count = start + segmentCount + markerCount;
		if (segmentCount + markerCount > 0) this.markEdgeInstances(start, start + segmentCount + markerCount, false);
		this.overlayEdgeIndices = overlay;
		// Short pinned edges are in the sub-pixel count of the layer, yet drawn here.
		const drawnShort =
			this.mode === "2d" && !this.lensApplied
				? dropSubPixelEdges(overlay, this.canonicalEdgePositions, this.worldUnitsPerPixel(), SUB_PIXEL_EDGE_PIXELS)
						.skipped
				: 0;
		this.subPixelEdgesSkipped = Math.max(0, main.subPixelSkipped - drawnShort);
		this.visibleEdgeSegmentCount = main.segments + segmentCount;
		this.visibleEdgeMarkerCount = main.markers + markerCount;
		this.visibleEdgeCount = main.edges + distinct;
		return true;
	}

	/** Selected edges and every edge of a selected, focused or hovered node: never culled or budgeted away. */
	private pinnedEdgeIndices(): ReadonlySet<number> {
		const pinned = new Set<number>();
		// The id map holds every edge id, so it is built only when an edge is selected.
		const edgeIndices = this.selectedEdgeIds.size > 0 ? this.edgeIndicesById() : null;
		for (const id of this.selectedEdgeIds) {
			const edgeIndex = edgeIndices?.get(id);
			if (edgeIndex !== undefined) pinned.add(edgeIndex);
		}
		for (const ids of [this.selectedNodeIds, this.focusedNodeIds, this.hoveredNodeIds]) {
			for (const id of ids) {
				const nodeIndex = this.nodeIndices.get(id);
				for (const edgeIndex of nodeIndex === undefined ? [] : (this.incidentEdgeIndices[nodeIndex] ?? [])) {
					pinned.add(edgeIndex);
				}
			}
		}
		return pinned;
	}

	/** A node drawn at its own position and size, which is every node outside the density tier. */
	private plainMaterializedNode(index: number): MaterializedNode | null {
		const node = this.data.nodes[index];
		if (!node) return null;
		const { height, width } = resolveNodeAxes({
			height: node.height,
			nodeId: node.id,
			size: node.size,
			width: node.width,
		});
		return { height, index, width, x: node.position.x, y: node.position.y, z: node.position.z ?? 0 };
	}

	private nodeInstanceTargets(): NodeInstanceTargets {
		const geometry = (this.nodeMesh as InstancedMesh).geometry;
		return {
			blendA: geometry.getAttribute("instanceBlendA") as InstancedBufferAttribute,
			blendB: geometry.getAttribute("instanceBlendB") as InstancedBufferAttribute,
			icon: geometry.getAttribute("instanceIcon") as InstancedBufferAttribute,
			matrix: new Matrix4(),
			shape: geometry.getAttribute("instanceShape") as InstancedBufferAttribute,
			strokeColor: geometry.getAttribute("instanceStrokeColor") as InstancedBufferAttribute,
			strokeWidth: geometry.getAttribute("instanceStrokeWidth") as InstancedBufferAttribute,
		};
	}

	/** Writes one node's matrix, pick matrix, color, shape and stroke into `slot`. */
	private writeNodeInstance(
		{ blendA, blendB, icon, matrix, shape, strokeColor, strokeWidth }: NodeInstanceTargets,
		slot: number,
		materialized: MaterializedNode,
		node: GraphraumNode<NodeAttributes>,
	) {
		const { height, width } = materialized;
		const maxAxis = Math.max(width, height);
		matrix.makeScale(width, height, maxAxis);
		matrix.setPosition(materialized.x, materialized.y, materialized.z);
		(this.nodeMesh as InstancedMesh).setMatrixAt(slot, matrix);
		const pickScale = maxAxis * Math.SQRT2 * this.lensPickGrowth();
		matrix.makeScale(pickScale, pickScale, pickScale);
		matrix.setPosition(materialized.x, materialized.y, materialized.z);
		(this.nodePickMesh as InstancedMesh).setMatrixAt(slot, matrix);
		(this.nodeMesh as InstancedMesh).setColorAt(slot, this.getNodeColor(node));
		setNodeShapeAt(shape, slot, node.shape);
		setNodeIconAt(icon, slot, node.icon);
		setNodeBlendAt(blendA, blendB, slot, node.blend);
		setNodeStrokeAt(strokeWidth, strokeColor, slot, resolveNodeStroke(node, this.theme, this.extras.node.strokeWidth));
	}

	private packEdges(edgeIndices: readonly number[], maxSegments?: number) {
		return packEdgeInstances({
			edgeIndices,
			edgeStates: this.edgeStateStyling(),
			edgeVisuals: this.data.edges,
			endpointPositions: this.canonicalEdgePositions,
			defaults: this.edgeDefaults(),
			tier: this.lastEdgeLodTier,
			maxSegments,
			endpointAttach: this.endpointAttach(),
			edgeNodeIndices: this.edgeNodeIndices,
			mode: this.mode,
			nodeOutlines: this.data.nodes,
		});
	}

	/**
	 * Writes packed edge instances at the given first slots and records what picking needs for them.
	 * Returns how many distinct edges got a segment.
	 */
	private writeEdgeInstances(
		packed: { markers: readonly EdgeMarkerInstance[]; segments: readonly EdgeSegmentInstance[] },
		start: { markerStart: number; segmentStart: number },
	): number {
		this.reserveEdgeInstances(
			Math.max(start.segmentStart + packed.segments.length, start.markerStart + packed.markers.length),
		);
		const edgeGeometry = (this.edgeMesh as InstancedMesh).geometry;
		const minHitSlop = Math.max(4, this.theme.edgeWidth);
		const distinctEdges = new Set<number>();
		// 2D picks the closest segment on the CPU; 3D raycasts the instances and needs no copies of them.
		const keepPickable = this.camera instanceof OrthographicCamera;
		for (const [offset, segment] of packed.segments.entries()) {
			const slot = start.segmentStart + offset;
			writeEdgeSegmentInstance(edgeGeometry, slot, segment);
			distinctEdges.add(segment.edgeIndex);
			if (keepPickable) this.pickableEdgeSegments[slot] = pickableSegment(segment, minHitSlop);
			else this.visibleEdgeSegmentEdgeIndices[slot] = segment.edgeIndex;
		}
		for (const [offset, marker] of packed.markers.entries()) {
			writeEdgeMarkerInstance(edgeGeometry, start.markerStart + offset, marker);
		}
		return distinctEdges.size;
	}

	private visibleNodeSlot(index: number): number | undefined {
		const slot = this.nodeSlots[index];
		return slot === undefined || slot < 0 ? undefined : slot;
	}

	private assignNodeSlot(index: number, slot: number) {
		if (index >= this.nodeSlots.length) {
			const grown = new Int32Array(Math.max(index + 1, this.data.nodes.length)).fill(-1);
			grown.set(this.nodeSlots);
			this.nodeSlots = grown;
		}
		this.nodeSlots[index] = slot;
	}

	/** Rewrites every node instance: the first pass, and any change a camera move does not explain. */
	private writeAllNodeInstances(materializedNodes: readonly MaterializedNode[], visibleNodeIndices: number[]) {
		const { nodeMesh, nodePickMesh } = this;
		if (!nodeMesh || !nodePickMesh) return;
		this.nodeSlots = new Int32Array(Math.max(this.data.nodes.length, 1)).fill(-1);
		this.nodeSlotsPlain = !this.densityLodActive;
		this.visibleNodeIndices = visibleNodeIndices;
		const targets = this.nodeInstanceTargets();
		for (const [slot, materialized] of materializedNodes.entries()) {
			const node = this.data.nodes[materialized.index];
			if (!node) continue;
			this.nodeSlots[materialized.index] = slot;
			this.writeNodeInstance(targets, slot, materialized, node);
		}
		this.markNodeInstances([[0, materializedNodes.length]], materializedNodes.length, true);
	}

	/**
	 * Moves the drawn nodes to `candidates` by writing only the nodes that entered. A node that left frees
	 * its slot for an entering one; slots still free are filled by the last drawn nodes, so the drawn
	 * slots stay contiguous. Slot order is not the grid order of a full pass, which also changes
	 * with every camera move, so only the paint order of overlapping nodes can differ.
	 */
	private patchNodeSlots(candidates: readonly number[]) {
		const indices = this.visibleNodeIndices as number[];
		// Slots never pass the drawn count plus the entering nodes, which are at most the candidates.
		const size = indices.length + candidates.length;
		if (this.slotKeep.length < size) this.slotKeep = new Uint8Array(size * 2);
		const keep = this.slotKeep.fill(0, 0, size);
		const entering: number[] = [];
		for (const index of candidates) {
			const slot = this.visibleNodeSlot(index);
			if (slot === undefined) entering.push(index);
			else keep[slot] = 1;
		}
		const holes: number[] = [];
		const leaving: number[] = [];
		for (let slot = 0; slot < indices.length; slot += 1) {
			if (keep[slot]) continue;
			this.nodeSlots[indices[slot] as number] = -1;
			leaving.push(indices[slot] as number);
			holes.push(slot);
		}
		const targets = this.nodeInstanceTargets();
		const written: [number, number][] = [];
		const place = (index: number, slot: number) => {
			const materialized = this.plainMaterializedNode(index);
			const node = this.data.nodes[index];
			if (!materialized || !node) return;
			indices[slot] = index;
			this.assignNodeSlot(index, slot);
			this.writeNodeInstance(targets, slot, materialized, node);
			keep[slot] = 1;
			written.push([slot, slot + 1]);
		};
		let end = indices.length;
		let hole = 0;
		for (const index of entering) {
			if (hole < holes.length) place(index, holes[hole++] as number);
			else {
				end += 1;
				place(index, end - 1);
			}
		}
		for (; hole < holes.length; hole += 1) {
			while (end > 0 && !keep[end - 1]) end -= 1;
			const slot = holes[hole] as number;
			if (slot >= end) break;
			keep[slot] = 1;
			keep[end - 1] = 0;
			place(indices[end - 1] as number, slot);
			end -= 1;
		}
		while (end > 0 && !keep[end - 1]) end -= 1;
		indices.length = end;
		this.markNodeInstances(written, end, false);
		return { entering, indices, leaving };
	}

	/** Flags the edge instances in `[start, end)` for upload; `clear` drops the ranges flagged before. */
	/**
	 * Re-sizes the edge buffers to hold `used` slots in use plus headroom for the selection overlay and
	 * later camera moves, keeping nothing: a full pass writes every slot again. Memory follows the edges
	 * drawn, not the edge count or the budget, and shrinks when a pass needs far less than is held.
	 */
	private fitEdgeInstances(used: number) {
		const { edgeMesh } = this;
		if (!edgeMesh) return;
		const wanted = Math.min(this.edgeInstanceCapacity, used + Math.max(used >> 2, MIN_EDGE_HEADROOM));
		const held = edgeGeometryCapacity(edgeMesh.geometry);
		if (wanted <= held && held <= wanted * 4) return;
		this.swapEdgeGeometry(wanted, 0);
	}

	/** Makes room for `slots` slots, growing geometrically and keeping the first `keep` slots written. */
	private reserveEdgeInstances(slots: number, keep = slots) {
		const { edgeMesh } = this;
		if (!edgeMesh) return;
		const held = edgeGeometryCapacity(edgeMesh.geometry);
		if (slots <= held) return;
		this.swapEdgeGeometry(Math.min(this.edgeInstanceCapacity, Math.max(slots, held * 2)), keep);
	}

	private swapEdgeGeometry(capacity: number, keep: number) {
		const { edgeMesh } = this;
		if (!edgeMesh) return;
		const previous = edgeMesh.geometry;
		edgeMesh.geometry = resizeEdgeGeometry(previous, capacity, keep);
		previous.dispose();
	}

	private markEdgeInstances(start: number, end: number, clear: boolean) {
		for (const name of EDGE_INSTANCE_ATTRIBUTES) {
			const attribute = getInstancedAttribute((this.edgeMesh as InstancedMesh).geometry, name);
			if (clear) attribute.clearUpdateRanges();
			attribute.addUpdateRange(start * attribute.itemSize, (end - start) * attribute.itemSize);
			attribute.needsUpdate = true;
		}
	}

	/** Flags the written slot ranges for upload and sets the drawn count. */
	private markNodeInstances(ranges: readonly [number, number][], count: number, clear: boolean) {
		const { nodeMesh, nodePickMesh } = this;
		if (!nodeMesh || !nodePickMesh) return;
		const attributes = [
			[nodeMesh.instanceMatrix, 16],
			[nodePickMesh.instanceMatrix, 16],
			[nodeMesh.instanceColor, 3],
			...(["instanceShape", "instanceIcon", "instanceStrokeWidth"] as const).map(
				(name) => [getInstancedAttribute(nodeMesh.geometry, name), 1] as const,
			),
			[getInstancedAttribute(nodeMesh.geometry, "instanceStrokeColor"), 3],
			[getInstancedAttribute(nodeMesh.geometry, "instanceBlendA"), 4],
			[getInstancedAttribute(nodeMesh.geometry, "instanceBlendB"), 4],
		] as const;
		for (const [attribute, size] of attributes) {
			if (!attribute) continue;
			if (clear) attribute.clearUpdateRanges();
			for (const [start, end] of ranges) attribute.addUpdateRange(start * size, (end - start) * size);
			attribute.needsUpdate = true;
		}
		nodeMesh.count = count;
		nodePickMesh.count = count;
	}

	private materializeNodes(indices: readonly number[], bounds: Bounds2D | null): readonly MaterializedNode[] {
		if (!this.densityLodActive || !bounds) {
			return indices.slice(0, this.nodeBudget).flatMap((index) => {
				const materialized = this.plainMaterializedNode(index);
				return materialized ? [materialized] : [];
			});
		}
		const aspect = Math.max(this.container.clientWidth, 1) / Math.max(this.container.clientHeight, 1);
		const columns = Math.max(1, Math.floor(Math.sqrt(this.nodeBudget * aspect)));
		const rows = Math.max(1, Math.floor(this.nodeBudget / columns));
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
		return [...clusters.values()].slice(0, this.nodeBudget);
	}

	private disposeGraphObjects() {
		this.nodeSlotsPlain = false;
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

/** `array`, or a copy with room for at least `length` entries, doubling so repeated appends stay cheap. */
function grown<T extends Float32Array | Uint32Array>(array: T, length: number): T {
	if (array.length >= length) return array;
	const next = new (array.constructor as new (size: number) => T)(nextCapacity(length));
	next.set(array);
	return next;
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
