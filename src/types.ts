export type GraphraumColor = number | string;

export type GraphraumMode = "2d" | "3d";

/**
 * How edges and nodes share depth in 3D.
 * - `behind-nodes` (default): edges draw under every node, wherever they run.
 * - `scene`: circle nodes render as sphere impostors that write their surface depth, and edges and
 *   arrowheads depth-test against them, so an edge passes in front of or behind a node by its real
 *   position. No extra draw calls. A no-op in 2D.
 */
export type GraphraumEdgeDepth = "behind-nodes" | "scene";

/** Scene options for `Graphraum.setScene`. Every field is optional; omitted fields keep their value. */
export interface GraphraumSceneOptions {
	/** Default `"behind-nodes"`. */
	edgeDepth?: GraphraumEdgeDepth;
}

/** The scene options in effect, as returned by `Graphraum.getScene`. */
export interface ResolvedGraphraumSceneOptions {
	readonly edgeDepth: GraphraumEdgeDepth;
}

export type GraphraumNodeState = "dimmed" | "focused" | "hovered" | "selected";

/** Application-owned edge state applied with `setEdgeState`. Edge selection uses `setEdgeSelection`. */
export type GraphraumEdgeState = "dimmed";

export type GraphraumNodeShape = "circle" | "diamond" | "hexagon" | "pill" | "rounded" | "square" | "triangle";

export interface GraphraumPosition {
	x: number;
	y: number;
	z?: number;
}

type GraphraumAttributes<Attributes> = [Attributes] extends [undefined]
	? { attributes?: never }
	: { attributes: Attributes };

export interface GraphraumNodeGeometry {
	id: string;
	position: GraphraumPosition;
	color?: GraphraumColor;
	/**
	 * Opt-in soft halo in 0..1 (default 0, none). Glowing nodes add one batched draw call;
	 * see the visual-language docs for the radius and opacity mapping.
	 */
	glow?: number;
	height?: number;
	shape?: GraphraumNodeShape;
	size?: number;
	strokeColor?: GraphraumColor;
	strokeWidth?: number;
	width?: number;
}

export type GraphraumNode<NodeAttributes = undefined> = GraphraumNodeGeometry & GraphraumAttributes<NodeAttributes>;

export interface GraphraumNodeUpdate {
	color?: GraphraumColor | undefined;
	glow?: number | undefined;
	height?: number | undefined;
	id: string;
	position?: GraphraumPosition;
	shape?: GraphraumNodeShape | undefined;
	size?: number | undefined;
	strokeColor?: GraphraumColor | undefined;
	strokeWidth?: number | undefined;
	width?: number | undefined;
}

/** A transferable XYZ position batch in the same order as `nodeIds`. */
export interface GraphraumLayoutPositions {
	nodeIds: readonly string[];
	positions: Float32Array;
}

export type GraphraumEdgeStyle = "solid" | "dashed" | "dotted";
export type GraphraumEdgeMarker = "none" | "triangle";
export type GraphraumEdgeMarkerEnd = "target" | "source" | "both";
export type GraphraumEdgePath = "straight" | "quadratic" | "cubic";

export type GraphraumEdge<EdgeAttributes = undefined> = {
	color?: GraphraumColor;
	width?: number;
	opacity?: number;
	style?: GraphraumEdgeStyle;
	marker?: GraphraumEdgeMarker;
	markerSize?: number;
	markerEnd?: GraphraumEdgeMarkerEnd;
	path?: GraphraumEdgePath;
	controlPoints?: readonly GraphraumPosition[];
	id: string;
	source: string;
	target: string;
} & GraphraumAttributes<EdgeAttributes>;

export interface GraphraumData<NodeAttributes = undefined, EdgeAttributes = undefined> {
	nodes: readonly GraphraumNode<NodeAttributes>[];
	edges: readonly GraphraumEdge<EdgeAttributes>[];
}

export interface GraphraumSetDataOptions {
	/**
	 * Fit the camera to the new data (default `true`). `false` replaces the data and leaves the camera
	 * where it is, for hosts that pass a full snapshot on every change. On a graph that never had a
	 * fit the camera keeps its initial pose, so call `fitView()` once after the first data.
	 */
	fit?: boolean;
}

export type GraphraumNodeDragPhase = "start" | "move" | "end" | "cancel";

/** One step of a node drag. `cancel` carries the position the node was restored to (or left at). */
export interface GraphraumNodeDragEvent {
	nodeId: string;
	phase: GraphraumNodeDragPhase;
	position: GraphraumPosition;
}

export interface GraphraumNodeDragOptions {
	enabled: boolean;
}

export interface GraphraumCameraPoint3d {
	x: number;
	y: number;
	z: number;
}

/**
 * A 2D view: where the camera looks and how much of the world it shows from top to bottom. The
 * visible width follows the canvas aspect, so a state read on one canvas size fits another.
 */
export interface GraphraumCameraState2d {
	center: { x: number; y: number };
	mode: "2d";
	/** World units from the top to the bottom edge of the canvas, with the current zoom applied. */
	visibleHeight: number;
}

/** A 3D view: the camera position and the point it orbits and looks at. */
export interface GraphraumCameraState3d {
	mode: "3d";
	position: GraphraumCameraPoint3d;
	target: GraphraumCameraPoint3d;
}

/** The camera pose as plain JSON, for saving a view and restoring it with `setCameraState()`. */
export type GraphraumCameraState = GraphraumCameraState2d | GraphraumCameraState3d;

export interface GraphraumDataPatch<NodeAttributes = undefined, EdgeAttributes = undefined> {
	addedNodes?: readonly GraphraumNode<NodeAttributes>[];
	addedEdges?: readonly GraphraumEdge<EdgeAttributes>[];
	removedNodeIds?: readonly string[];
	removedEdgeIds?: readonly string[];
}

export interface GraphraumNodeVisual {
	color?: GraphraumColor;
	/**
	 * Opt-in soft halo in 0..1 (default 0, none). Glowing nodes add one batched draw call;
	 * see the visual-language docs for the radius and opacity mapping.
	 */
	glow?: number;
	height?: number;
	shape?: GraphraumNodeShape;
	size?: number;
	strokeColor?: GraphraumColor;
	strokeWidth?: number;
	width?: number;
}

export interface GraphraumEdgeVisual {
	color?: GraphraumColor;
	width?: number;
	opacity?: number;
	style?: GraphraumEdgeStyle;
	marker?: GraphraumEdgeMarker;
	markerSize?: number;
	markerEnd?: GraphraumEdgeMarkerEnd;
	path?: GraphraumEdgePath;
	controlPoints?: readonly GraphraumPosition[];
}

export type GraphraumPropertyValue = boolean | null | number | string;

export interface GraphraumPresentationProperty {
	id: string;
	label: string;
	value: GraphraumPropertyValue;
}

export interface GraphraumPresentationAction {
	disabled?: boolean;
	id: string;
	label: string;
}

export interface GraphraumPresentation {
	actions?: readonly GraphraumPresentationAction[];
	properties?: readonly GraphraumPresentationProperty[];
	subtitle?: string;
	title: string;
}

export interface CompiledGraphraumPresentation extends GraphraumPresentation {
	actions: readonly Readonly<GraphraumPresentationAction>[];
	properties: readonly Readonly<GraphraumPresentationProperty>[];
}

export interface GraphraumScreenPosition {
	visible: boolean;
	x: number;
	y: number;
}

export interface GraphraumOverlayNode {
	id: string;
	presentation: CompiledGraphraumPresentation | null;
}

export interface GraphraumLabelCandidate {
	id: string;
	importance: number;
	visible: boolean;
}

export interface GraphraumOverlayOptions {
	/**
	 * Label refresh policy. `manual` only shows ids from `setLabels()`. `auto` budgets by
	 * importance on view change. `focus` budgets selected ∪ hovered ∪ 1-hop neighbors first.
	 * When omitted, `autoLabels: true` maps to `auto` for compatibility; otherwise `manual`.
	 */
	labelPolicy?: "manual" | "auto" | "focus";
	/**
	 * When `labelPolicy` is `focus`, controls whether leftover budget is filled by importance.
	 * Default `importance`. Use `none` for selected/hover/neighbor labels only.
	 */
	focusLabelFill?: "importance" | "none";
	/**
	 * @deprecated Prefer `labelPolicy: "auto"`. When `labelPolicy` is omitted, `true` enables `auto`.
	 */
	autoLabels?: boolean;
	/**
	 * When set with `renderToolbar`, keeps the toolbar pinned to the selected or hovered node.
	 * Default `false` — host calls `setToolbar` manually.
	 */
	autoToolbar?: false | "selected" | "hovered";
	overlayClassName?: string;
	maxLabels?: number;
	/**
	 * Hard cap for host HTML focus cards. Default 24. Manual `setRichNodes` throws when exceeded;
	 * `autoRichNodes` slices to the cap.
	 */
	maxRichNodes?: number;
	labelClassName?: string;
	toolbarClassName?: string;
	richNodeClassName?: string;
	/**
	 * When set with `renderRichNode`, keeps focus cards on selected and/or hovered nodes.
	 * Default `false` — host calls `setRichNodes`.
	 */
	autoRichNodes?: false | "selected" | "hovered" | "focus";
	renderLabel?: (node: GraphraumOverlayNode) => HTMLElement | null;
	renderToolbar?: (node: GraphraumOverlayNode) => HTMLElement | null;
	/** Host HTML for a strictly bounded focused subset. Not the dense node path. */
	renderRichNode?: (node: GraphraumOverlayNode) => HTMLElement | null;
}

export interface GraphraumNodeEncoding {
	presentation?: GraphraumPresentation;
	visual?: GraphraumNodeVisual;
}

export interface GraphraumEdgeEncoding {
	presentation?: GraphraumPresentation;
	visual?: GraphraumEdgeVisual;
}

export interface GraphraumVisualMapper<NodeAttributes = undefined, EdgeAttributes = undefined> {
	edge?: (edge: Readonly<GraphraumEdge<EdgeAttributes>>) => GraphraumEdgeEncoding | undefined;
	node?: (node: Readonly<GraphraumNode<NodeAttributes>>) => GraphraumNodeEncoding | undefined;
}

/**
 * Canvas backdrop.
 * - CSS color string paints a solid WebGL clear
 * - `null` / `"transparent"` leaves the canvas clear so a host CSS color, gradient, or pattern shows through
 * - `{ type: "pattern", source }` uses an image/canvas/bitmap as `scene.background`
 */
export type GraphraumPatternBackground = {
	type: "pattern";
	source: CanvasImageSource;
	/** Horizontal and vertical tile count. Default `[1, 1]` stretches to fill. */
	repeat?: readonly [number, number];
};

export type GraphraumBackground = GraphraumColor | GraphraumPatternBackground | "transparent" | null;

export type GraphraumThemeName = "dark" | "light";

export interface GraphraumTheme {
	background: GraphraumBackground;
	/** Color of edges dimmed with `setEdgeState("dimmed", ids)`. Selected edges stay selected. */
	dimmedEdge: GraphraumColor;
	/** Opacity cap (0..1) for dimmed edges; an edge that is already fainter keeps its own opacity. */
	dimmedEdgeOpacity: number;
	dimmedNode: GraphraumColor;
	edge: GraphraumColor;
	edgeOpacity: number;
	edgeWidth: number;
	/** How edge ends meet nodes. Default `boundary`. */
	endpointAttach: "boundary" | "center";
	focusedNode: GraphraumColor;
	hoveredNode: GraphraumColor;
	node: GraphraumColor;
	nodeStroke: GraphraumColor;
	selectedEdge: GraphraumColor;
	selectedNode: GraphraumColor;
}

/** Discriminated pick result. Nodes win over edges when both intersect the pointer. */
export type GraphraumPickHit = { kind: "edge"; id: string } | { kind: "node"; id: string };

/** `linear`, cubic `easeIn` / `easeOut` / `easeInOut`, or a function from progress 0..1 to eased 0..1. */
export type GraphraumEasing = "easeIn" | "easeInOut" | "easeOut" | "linear" | ((t: number) => number);

/** How depth of field animates focus moves and blur fades. */
export interface GraphraumDepthOfFieldTransition {
	/** Default 400; 0 jumps. `prefers-reduced-motion: reduce` always jumps. */
	durationMs?: number;
	/** Default `"easeInOut"`. */
	easing?: GraphraumEasing;
}

/**
 * Opt-in 3D depth of field. The focal plane follows the selection, so selected nodes stay sharp and
 * the rest of the graph blurs with its distance from them, in front and behind, like a thin lens:
 * the closer the camera is to the focus, the shallower the depth of field. A no-op in 2D. See
 * `Graphraum.setDepthOfField`.
 */
export interface GraphraumDepthOfFieldOptions {
	/** Default `false`. While disabled no extra passes or render targets exist. Toggling fades the blur. */
	enabled?: boolean;
	/**
	 * `"selection"` (default) focuses the mean position of the selected nodes and fades the blur out
	 * when nothing is selected. A number fixes the focal plane at that camera distance in world units.
	 */
	focus?: "selection" | number;
	/**
	 * Aperture, 0..1, default 0.5. A surface blurs by `strength * 24 * |d - f| / d` CSS pixels, where
	 * `d` is its camera distance and `f` the focal distance, clamped to `maxBlur`.
	 */
	strength?: number;
	/**
	 * Aperture for surfaces between the camera and the focus, 0..1. Defaults to `strength`. Set it
	 * above `strength` (with a larger `maxBlur`) to melt the foreground while the background behind
	 * the focus keeps the softer `strength` blur.
	 */
	nearStrength?: number;
	/** Largest blur radius in CSS pixels. Default 12. */
	maxBlur?: number;
	/** Blur radii below this many CSS pixels render sharp, which widens the in-focus band. Default 0. */
	minBlur?: number;
	/** Camera-to-focus distance in world units up to which `strength` applies fully. Default 0. */
	nearDistance?: number;
	/** Camera-to-focus distance in world units at which the blur has faded out. Default `Infinity` (no fade). */
	farDistance?: number;
	/** Animation for focus moves between selections and for blur fades. */
	transition?: GraphraumDepthOfFieldTransition;
}

/** Options for one `Graphraum.setDepthOfField` call. */
export interface GraphraumDepthOfFieldUpdate {
	/** Default `true`: fade the blur to the new strength over the transition. `false` jumps. */
	animate?: boolean;
}

/**
 * `off`: disabled. `inactive`: enabled with nothing to blur (2D mode, or no selection with
 * `focus: "selection"`), so frames render directly. `active`: the last frame ran the blur passes.
 * `unsupported`: enabled, but the WebGL context cannot run it, so frames render directly.
 */
export type GraphraumDepthOfFieldStatus = "active" | "inactive" | "off" | "unsupported";

export interface GraphraumOptions<NodeAttributes = undefined, EdgeAttributes = undefined> {
	antialias?: boolean;
	/** Opt-in 3D depth of field; off by default. Change it later with `setDepthOfField`. */
	depthOfField?: GraphraumDepthOfFieldOptions;
	/** Scene options; see `Graphraum.setScene`. */
	scene?: GraphraumSceneOptions;
	maxVisibleEdges?: number;
	maxVisibleNodes?: number;
	maxPixelRatio?: number;
	mode?: GraphraumMode;
	/** Named preset (`"dark"` / `"light"`) or a partial override merged onto dark. */
	theme?: Partial<GraphraumTheme> | GraphraumThemeName;
	viewportCulling?: boolean;
	viewportOverscan?: number;
	visuals?: GraphraumVisualMapper<NodeAttributes, EdgeAttributes>;
}

/** Options for `Graphraum.setAutoOrbit`. */
export interface GraphraumAutoOrbitOptions {
	/** Orbit speed in radians per second. Must be above 0 and at most 2. Defaults to 0.07 (about 90 seconds per turn). */
	speed?: number;
	/** Idle time in milliseconds after a pointer, wheel or key interaction before the orbit resumes. Defaults to 3000. */
	resumeAfterMs?: number;
}

/** Options for `Graphraum.flyTo`. */
export interface GraphraumFlyToOptions {
	/** Nodes to frame, as `fitView({ nodeIds })` frames them. Unknown IDs are ignored. */
	nodeIds: readonly string[];
	/** Flight time in milliseconds. 0 jumps. Defaults to 1200. */
	durationMs?: number;
	/** Multiplies the fitted 3D camera distance or 2D visible height; above 1 leaves air around the nodes. Defaults to 1. */
	distanceScale?: number;
}

/** `off`: not enabled. `active`: orbiting with a running frame loop. `paused`: enabled but stopped by interaction, a hidden tab or an off-screen canvas. */
export type GraphraumAutoOrbitStatus = "active" | "off" | "paused";

export interface GraphraumDiagnostics {
	aggregatedNodeClusters: number;
	autoOrbit: GraphraumAutoOrbitStatus;
	cpuFrameMilliseconds: number;
	depthOfField: GraphraumDepthOfFieldStatus;
	/** Edge depth in effect for the last frame: `scene` only in 3D with `scene.edgeDepth: "scene"`. */
	edgeDepth: GraphraumEdgeDepth;
	gpuFrameMilliseconds: number | null;
	gpuDrawCalls: number;
	gpuGeometries: number;
	gpuTextures: number;
	lodLevel: "density" | "detail" | "overview";
	pickingStrategy: "raycaster-3d" | "spatial-grid-2d";
	dimmedEdges: number;
	selectedEdges: number;
	selectedNodes: number;
	totalEdges: number;
	totalNodes: number;
	visibleEdgeCandidates: number;
	visibleEdgeMarkers: number;
	visibleEdgeSegments: number;
	visibleEdges: number;
	/** Glow halo instances in the final frame (at most 256; 0 in the density LOD tier). */
	visibleGlowNodes: number;
	visibleNodes: number;
	visibleNodeCandidates: number;
}
