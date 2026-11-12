import { formatCount, labelFits } from "./lod-format";

export interface LabelItem {
	count: number;
	id: string;
}

export interface LabelPosition {
	radius: number;
	visible: boolean;
	x: number;
	y: number;
}

/** Aggregates of fewer members than this get no label: the count would say little. */
const MINIMUM_LABELED_COUNT = 8;
/** At most this many labels at once, so a busy view stays cheap. */
const MAXIMUM_LABELS = 400;

const LABEL_STYLE =
	"position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;font:600 11px/1 system-ui,sans-serif;" +
	"color:#fff;text-shadow:0 0 2px rgba(0,0,0,.85),0 0 5px rgba(0,0,0,.6);will-change:transform;";

/** A DOM layer of compact count labels over the canvas. Hidden labels sit in a pool for reuse. */
export function createLabelLayer(element: HTMLElement, position: (id: string) => LabelPosition | null) {
	const root = document.createElement("div");
	root.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;";
	root.setAttribute("aria-hidden", "true");
	const previousPosition = getComputedStyle(element).position === "static" ? element.style.position : null;
	if (previousPosition !== null) element.style.position = "relative";
	element.append(root);
	const pool: HTMLElement[] = [];
	let items: readonly LabelItem[] = [];

	function update() {
		let used = 0;
		for (const { count, id } of items) {
			if (used >= MAXIMUM_LABELS) break;
			if (count < MINIMUM_LABELED_COUNT) continue;
			const text = formatCount(count);
			const at = position(id);
			if (!at?.visible || !labelFits(text, at.radius)) continue;
			let label = pool[used];
			if (!label) {
				label = document.createElement("span");
				label.style.cssText = LABEL_STYLE;
				root.append(label);
				pool.push(label);
			}
			if (label.textContent !== text) label.textContent = text;
			label.hidden = false;
			label.style.transform = `translate(${at.x}px,${at.y}px) translate(-50%,-50%)`;
			used += 1;
		}
		for (let index = used; index < pool.length; index += 1) (pool[index] as HTMLElement).hidden = true;
	}

	return {
		destroy() {
			root.remove();
			if (previousPosition !== null) element.style.position = previousPosition;
		},
		/** Number of labels showing, for tests and diagnostics. */
		shown: () => pool.filter((label) => !label.hidden).length,
		update,
		setItems(next: readonly LabelItem[]) {
			items = next;
		},
	};
}
