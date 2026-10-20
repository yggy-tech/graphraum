import type { CompiledGraphraumPresentation } from "@yggy-tech/graphraum";

import type { PlaygroundScene } from "../lib/playground-scenes";
import type { DemoUseCase } from "../lib/use-case-demos";
import { requireElement } from "./dom";

const MAX_RELATIONS = 8;

export interface InspectorRelation {
	label: string;
	nodeId: string;
	relationship: string;
}

export interface InspectorAction {
	id: string;
	label: string;
	disabled?: boolean;
}

export interface InspectorCallbacks {
	onAction: (nodeId: string, actionId: string) => void;
	onSelect: (nodeId: string) => void;
}

/** Host-owned detail panel. graphraum only supplies IDs and compiled presentations. */
export class Inspector {
	private readonly title: HTMLElement;
	private readonly subtitle: HTMLElement;
	private readonly swatch: HTMLElement;
	private readonly chips: HTMLElement;
	private readonly relations: HTMLElement;
	private readonly actions: HTMLElement;
	private readonly message: HTMLElement;
	private readonly entities: HTMLSelectElement;
	private nodeId: string | null = null;

	constructor(
		root: HTMLElement,
		private readonly callbacks: InspectorCallbacks,
	) {
		this.title = requireElement(root, "[data-insp-title]");
		this.subtitle = requireElement(root, "[data-insp-subtitle]");
		this.swatch = requireElement(root, "[data-insp-swatch]");
		this.chips = requireElement(root, "[data-insp-chips]");
		this.relations = requireElement(root, "[data-insp-relations]");
		this.actions = requireElement(root, "[data-insp-actions]");
		this.message = requireElement(root, "[data-insp-message]");
		this.entities = requireElement(root, "[data-insp-entities]");
		this.entities.addEventListener("change", () => {
			if (this.entities.value) callbacks.onSelect(this.entities.value);
		});
	}

	/** Fills the "Jump to" list; an empty list hides it (the stress scene has too many nodes). */
	setEntities(useCase: DemoUseCase | null) {
		const nodes = useCase
			? [...useCase.data.nodes].sort((left, right) => left.attributes.label.localeCompare(right.attributes.label))
			: [];
		const placeholder = new Option("Choose an entity", "");
		this.entities.replaceChildren(
			placeholder,
			...nodes.map((node) => new Option(`${node.attributes.label} (${node.attributes.category})`, node.id)),
		);
		this.entities.closest("label")?.toggleAttribute("hidden", nodes.length === 0);
	}

	showScene(scene: PlaygroundScene) {
		this.nodeId = null;
		this.render({
			actions: [],
			chips: [],
			color: null,
			relations: [],
			subtitle: `${scene.description} Click a node to inspect it.`,
			title: scene.title,
		});
		this.entities.value = "";
	}

	showNode(
		nodeId: string,
		presentation: CompiledGraphraumPresentation | null,
		details: { color: string | null; relations: readonly InspectorRelation[]; extraChips?: readonly string[] },
	) {
		this.nodeId = nodeId;
		this.render({
			actions: presentation?.actions ?? [],
			chips: [
				...(presentation?.properties ?? []).map(({ label, value }) => `${label}: ${value ?? "none"}`),
				...(details.extraChips ?? []),
			],
			color: details.color,
			relations: details.relations,
			subtitle: presentation?.subtitle ?? "",
			title: presentation?.title ?? nodeId,
		});
		if ([...this.entities.options].some(({ value }) => value === nodeId)) this.entities.value = nodeId;
	}

	showMessage(text: string) {
		this.message.textContent = text;
	}

	private render(view: {
		actions: readonly InspectorAction[];
		chips: readonly string[];
		color: string | null;
		relations: readonly InspectorRelation[];
		subtitle: string;
		title: string;
	}) {
		this.title.textContent = view.title;
		this.subtitle.textContent = view.subtitle;
		this.swatch.hidden = view.color === null;
		this.swatch.style.background = view.color ?? "";
		this.message.textContent = "";
		this.chips.replaceChildren(
			...view.chips.map((text) => {
				const chip = document.createElement("span");
				chip.className = "chip";
				chip.textContent = text;
				return chip;
			}),
		);
		const shown = view.relations.slice(0, MAX_RELATIONS);
		this.relations.replaceChildren(
			...shown.map((relation) => {
				const button = document.createElement("button");
				button.type = "button";
				const label = document.createElement("span");
				label.textContent = relation.label;
				const kind = document.createElement("small");
				kind.textContent = relation.relationship;
				button.append(label, kind);
				button.addEventListener("click", () => this.callbacks.onSelect(relation.nodeId));
				return button;
			}),
		);
		if (view.relations.length > shown.length) {
			const more = document.createElement("p");
			more.className = "more";
			more.textContent = `and ${view.relations.length - shown.length} more`;
			this.relations.append(more);
		}
		this.relations.hidden = view.relations.length === 0;
		this.actions.replaceChildren(
			...view.actions.map((action) => {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "gbtn small";
				button.disabled = action.disabled ?? false;
				button.textContent = action.label;
				button.addEventListener("click", () => {
					if (this.nodeId) this.callbacks.onAction(this.nodeId, action.id);
				});
				return button;
			}),
		);
	}
}
