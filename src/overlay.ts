import type { Graphraum } from "./graphraum";
import { orderFocusNodeIds, selectBudgetedLabelIds, selectFocusLabelIds } from "./label-budget";
import { boundOverlayIds, type RichNodePolicy, selectRichNodeIds } from "./overlay-budget";
import type { CompiledGraphraumPresentation, GraphraumOverlayNode, GraphraumOverlayOptions } from "./types";

type OverlayEntry = {
	element: HTMLElement;
	presentation: CompiledGraphraumPresentation | null;
	/** True while the focus lens holds this label's opacity, so it is restored once the lens lets go. */
	lensFaded?: boolean;
};

type LabelPolicy = "manual" | "auto" | "focus";

function assertElement(element: HTMLElement | null, kind: string) {
	if (element !== null && !(element instanceof HTMLElement)) {
		throw new Error(`${kind} renderer must return an HTMLElement or null`);
	}
}

function resolveLabelPolicy(options: GraphraumOverlayOptions): LabelPolicy {
	if (options.labelPolicy) return options.labelPolicy;
	return options.autoLabels === true ? "auto" : "manual";
}

/** A bounded DOM layer for labels, a focused-node toolbar, and optional rich HTML cards. */
export class GraphraumOverlay<NodeAttributes = undefined, EdgeAttributes = undefined> {
	private readonly root = document.createElement("div");
	private readonly labels = new Map<string, OverlayEntry>();
	private readonly richNodes = new Map<string, OverlayEntry>();
	private toolbar: OverlayEntry | null = null;
	private toolbarNodeId: string | null = null;
	private readonly stopObservingView: () => void;
	private readonly stopObservingFocus: () => void;
	private readonly previousContainerPosition: string | null;
	private readonly labelPolicy: LabelPolicy;
	private readonly focusLabelFill: "importance" | "none";
	private readonly autoToolbar: false | "selected" | "hovered";
	private readonly autoRichNodes: false | RichNodePolicy;
	private readonly maxLabels: number;
	private readonly maxRichNodes: number;

	constructor(
		private readonly graph: Graphraum<NodeAttributes, EdgeAttributes>,
		private readonly container: HTMLElement,
		private readonly options: GraphraumOverlayOptions,
	) {
		const maxLabels = options.maxLabels ?? 50;
		if (!Number.isSafeInteger(maxLabels) || maxLabels < 0) {
			throw new Error("Overlay maxLabels must be a non-negative integer.");
		}
		this.maxLabels = maxLabels;
		const maxRichNodes = options.maxRichNodes ?? 24;
		if (!Number.isSafeInteger(maxRichNodes) || maxRichNodes < 0) {
			throw new Error("Overlay maxRichNodes must be a non-negative integer.");
		}
		this.maxRichNodes = maxRichNodes;
		this.labelPolicy = resolveLabelPolicy(options);
		this.focusLabelFill = options.focusLabelFill ?? "importance";
		this.autoToolbar = options.autoToolbar ?? false;
		this.autoRichNodes = options.autoRichNodes ?? false;
		this.root.className = `graphraum-overlay ${options.overlayClassName ?? ""}`.trim();
		this.root.style.cssText = "inset:0;pointer-events:none;position:absolute;";
		this.previousContainerPosition =
			getComputedStyle(this.container).position === "static" ? this.container.style.position : null;
		if (this.previousContainerPosition !== null) this.container.style.position = "relative";
		this.container.append(this.root);
		this.stopObservingView = graph.onViewChange(() => this.update());
		this.stopObservingFocus = graph.onFocusChange(() => this.update());
	}

	/**
	 * Replaces the labeled node set. When `labelPolicy` is `auto` or `focus`, the next view/focus
	 * change overwrites this list from the policy.
	 */
	setLabels(nodeIds: Iterable<string>) {
		this.syncLabels(boundOverlayIds(nodeIds, this.maxLabels, "labels"));
		this.updatePositions();
	}

	/**
	 * Replaces the rich HTML node set. When `autoRichNodes` is set, the next focus change
	 * overwrites this list from the policy.
	 */
	setRichNodes(nodeIds: Iterable<string>) {
		if (this.autoRichNodes) return;
		this.syncRichNodes(boundOverlayIds(nodeIds, this.maxRichNodes, "rich nodes"));
		this.updatePositions();
	}

	setToolbar(nodeId: string | null) {
		if (this.autoToolbar) return;
		this.toolbar?.element.remove();
		this.toolbar = null;
		this.toolbarNodeId = nodeId;
		if (nodeId !== null) this.toolbar = this.createEntry(nodeId, this.options.renderToolbar, "Toolbar", "auto");
		this.updatePositions();
	}

	destroy() {
		this.stopObservingView();
		this.stopObservingFocus();
		this.root.remove();
		if (this.previousContainerPosition !== null && this.container.querySelector(".graphraum-overlay") === null)
			this.container.style.position = this.previousContainerPosition;
		this.labels.clear();
		this.richNodes.clear();
		this.toolbar = null;
	}

	private update() {
		if (this.labelPolicy === "auto") {
			this.syncLabels(
				selectBudgetedLabelIds({
					candidates: this.graph.getLabelCandidates(),
					maxLabels: this.maxLabels,
				}),
			);
		} else if (this.labelPolicy === "focus") {
			const selectedIds = this.graph.getSelectedNodeIds();
			const hoveredIds = this.graph.getHoveredNodeIds();
			const neighborIds = [...selectedIds, ...hoveredIds].flatMap((id) => this.graph.getNeighborIds(id));
			this.syncLabels(
				selectFocusLabelIds({
					focusIds: orderFocusNodeIds({ selectedIds, hoveredIds, neighborIds }),
					candidates: this.graph.getLabelCandidates(),
					maxLabels: this.maxLabels,
					fill: this.focusLabelFill,
				}),
			);
		}
		if (this.autoToolbar) this.syncToolbar();
		if (this.autoRichNodes) this.syncRichNodesFromFocus();
		this.updatePositions();
	}

	private syncRichNodesFromFocus() {
		if (!this.autoRichNodes || !this.options.renderRichNode) return;
		this.syncRichNodes(
			selectRichNodeIds({
				hoveredIds: this.graph.getHoveredNodeIds(),
				maxRichNodes: this.maxRichNodes,
				policy: this.autoRichNodes,
				selectedIds: this.graph.getSelectedNodeIds(),
			}),
		);
	}

	private syncToolbar() {
		if (!this.options.renderToolbar) return;
		const nextId =
			this.autoToolbar === "hovered"
				? (this.graph.getHoveredNodeIds()[0] ?? this.graph.getSelectedNodeIds()[0] ?? null)
				: (this.graph.getSelectedNodeIds()[0] ?? null);
		if (nextId === this.toolbarNodeId && this.toolbar) return;
		this.toolbar?.element.remove();
		this.toolbar = null;
		this.toolbarNodeId = nextId;
		if (nextId !== null) this.toolbar = this.createEntry(nextId, this.options.renderToolbar, "Toolbar", "auto");
	}

	private syncLabels(nodeIds: readonly string[]) {
		const nextIds = new Set(nodeIds);
		for (const [nodeId, entry] of this.labels) {
			if (nextIds.has(nodeId)) continue;
			entry.element.remove();
			this.labels.delete(nodeId);
		}
		for (const nodeId of nodeIds) {
			if (this.labels.has(nodeId)) continue;
			const entry = this.createEntry(nodeId, this.options.renderLabel, "Label", "none");
			if (entry) this.labels.set(nodeId, entry);
		}
	}

	private syncRichNodes(nodeIds: readonly string[]) {
		const nextIds = new Set(nodeIds);
		for (const [nodeId, entry] of this.richNodes) {
			if (nextIds.has(nodeId)) continue;
			entry.element.remove();
			this.richNodes.delete(nodeId);
		}
		for (const nodeId of nodeIds) {
			if (this.richNodes.has(nodeId)) continue;
			const entry = this.createEntry(nodeId, this.options.renderRichNode, "Rich", "auto");
			if (entry) this.richNodes.set(nodeId, entry);
		}
	}

	private updatePositions() {
		for (const [nodeId, entry] of this.labels)
			this.updateEntry(nodeId, entry, this.options.renderLabel, "label", "none");
		for (const [nodeId, entry] of this.richNodes)
			this.updateEntry(nodeId, entry, this.options.renderRichNode, "rich", "auto");
		if (this.toolbar && this.toolbarNodeId)
			this.updateEntry(this.toolbarNodeId, this.toolbar, this.options.renderToolbar, "toolbar", "auto");
	}

	private createEntry(
		nodeId: string,
		render: ((node: GraphraumOverlayNode) => HTMLElement | null) | undefined,
		kind: string,
		pointerEvents: "auto" | "none",
	): OverlayEntry | null {
		if (!render || !this.graph.getNodeScreenPosition(nodeId)) return null;
		const presentation = this.graph.getNodePresentation(nodeId);
		const element = render({ id: nodeId, presentation });
		assertElement(element, kind);
		if (!element) return null;
		const className = `graphraum-overlay-${kind.toLowerCase()}`;
		element.classList.add("graphraum-overlay-entry", className);
		if (kind === "Label" && this.options.labelClassName) {
			this.applyClassName(element, this.options.labelClassName);
		}
		if (kind === "Toolbar" && this.options.toolbarClassName) {
			this.applyClassName(element, this.options.toolbarClassName);
		}
		if (kind === "Rich" && this.options.richNodeClassName) {
			this.applyClassName(element, this.options.richNodeClassName);
		}
		element.dataset.graphraumNodeId = nodeId;
		element.style.position = "absolute";
		element.style.pointerEvents = pointerEvents;
		this.root.append(element);
		return { element, presentation };
	}

	private updateEntry(
		nodeId: string,
		entry: OverlayEntry,
		render: ((node: GraphraumOverlayNode) => HTMLElement | null) | undefined,
		kind: "label" | "toolbar" | "rich",
		pointerEvents: "auto" | "none",
	) {
		const position = this.graph.getNodeScreenPosition(nodeId);
		entry.element.hidden = !position?.visible;
		if (!position?.visible) return;
		const anchor = kind === "rich" ? "translate(-50%, 12px)" : "translate(-50%, -100%)";
		entry.element.style.transform = `translate(${position.x}px, ${position.y}px) ${anchor}`;
		if (kind === "label") this.applyLensOpacity(entry, nodeId);
		const presentation = this.graph.getNodePresentation(nodeId);
		if (presentation === entry.presentation || !render) return;
		const replacement = render({ id: nodeId, presentation });
		assertElement(replacement, `${kind[0].toUpperCase()}${kind.slice(1)}`);
		if (!replacement) {
			entry.element.remove();
			if (kind === "toolbar") this.toolbar = null;
			else if (kind === "rich") this.richNodes.delete(nodeId);
			else this.labels.delete(nodeId);
			return;
		}
		const className = `graphraum-overlay-${kind}`;
		replacement.classList.add("graphraum-overlay-entry", className);
		if (kind === "label" && this.options.labelClassName) {
			this.applyClassName(replacement, this.options.labelClassName);
		}
		if (kind === "toolbar" && this.options.toolbarClassName) {
			this.applyClassName(replacement, this.options.toolbarClassName);
		}
		if (kind === "rich" && this.options.richNodeClassName) {
			this.applyClassName(replacement, this.options.richNodeClassName);
		}
		replacement.dataset.graphraumNodeId = nodeId;
		replacement.style.cssText = `${entry.element.style.cssText};position:absolute;pointer-events:${pointerEvents};`;
		entry.element.replaceWith(replacement);
		entry.element = replacement;
		entry.presentation = presentation;
	}

	/** Fades a label with the focus lens; touches the opacity only while the lens holds it. */
	private applyLensOpacity(entry: OverlayEntry, nodeId: string) {
		const alpha = this.graph.getFocusLensLabelAlpha(nodeId);
		if (alpha < 1) {
			entry.element.style.opacity = String(alpha);
			entry.lensFaded = true;
		} else if (entry.lensFaded) {
			entry.element.style.opacity = "";
			entry.lensFaded = false;
		}
	}

	private applyClassName(element: HTMLElement, className: string) {
		for (const token of className.split(/\s+/g)) {
			if (token) element.classList.add(token);
		}
	}
}
