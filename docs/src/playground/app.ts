import type { GraphraumMode } from "@yggy-tech/graphraum";

import {
	type DemoSceneId,
	type PlaygroundState,
	parsePlaygroundState,
	type StressSize,
	sceneById,
	sceneCode,
	serializePlaygroundState,
} from "../lib/playground-scenes";
import { proveRows } from "../lib/prove-reference";
import { resolveDemoAction } from "../lib/use-case-demos";
import { requireElement } from "./dom";
import { Inspector, type InspectorRelation } from "./inspector";
import { runProve } from "./prove";
import { PlaygroundStage } from "./stage";

/** Wires the playground page: scene bar, stage, inspector, settings, code dialog and Prove. */
export function startPlayground() {
	const root = requireElement(document, ".app");
	const settings = requireElement<HTMLFormElement>(root, "#settings");
	const settingsButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-settings-open]")];
	const sceneSelect = requireElement<HTMLSelectElement>(root, "#scene-select");
	const dofToggle = requireElement<HTMLButtonElement>(root, "[data-dof-toggle]");
	const dofStrength = requireElement<HTMLInputElement>(root, "[data-dof-strength]");
	const codeDialog = requireElement<HTMLDialogElement>(root, "#code-dialog");
	const codeBody = requireElement(codeDialog, "[data-code-body]");
	const prove = requireElement(root, "#prove");
	const proveRowsBody = requireElement(prove, "[data-prove-rows]");
	const proveMeta = requireElement(prove, "[data-prove-meta]");
	const proveKicker = requireElement(prove, "[data-prove-kicker]");
	const provePhase = requireElement(prove, "[data-prove-phase]");
	const provePercent = requireElement(prove, "[data-prove-percent]");
	const proveBar = requireElement(prove, "[data-prove-bar]");
	const proveRun = requireElement<HTMLButtonElement>(prove, "[data-prove-run]");
	const proveCopy = requireElement<HTMLButtonElement>(prove, "[data-prove-copy]");
	const status = {
		calls: requireElement(root, "[data-status-calls]"),
		edges: requireElement(root, "[data-status-edges]"),
		frame: requireElement(root, "[data-status-frame]"),
		nodes: requireElement(root, "[data-status-nodes]"),
	};

	let state: PlaygroundState = parsePlaygroundState(location.search);
	let proveResult: { json: string; measures: Parameters<typeof proveRows>[0] } | null = null;
	let proving = false;
	let layoutText = "";

	const stage = new PlaygroundStage(requireElement(root, "#stage"), (text) => {
		layoutText = text;
	});
	const inspector = new Inspector(requireElement(root, "#inspector"), {
		onAction: (nodeId, actionId) => {
			const scene = stage.current;
			if (scene?.kind !== "demo") {
				inspector.showMessage(`${actionId} on ${nodeId} is handled by your app.`);
				return;
			}
			const result = resolveDemoAction(scene.useCase, nodeId, actionId);
			scene.graph.setSelection(result.selectedNodeIds);
			inspector.showMessage(result.message);
		},
		onSelect: (nodeId) => select(nodeId),
	});

	function select(nodeId: string | null) {
		const scene = stage.current;
		if (!scene) return;
		stage.focus(nodeId);
		if (!nodeId) {
			inspector.showScene(sceneById(state.scene));
			return;
		}
		if (scene.kind === "demo") {
			const nodes = new Map(scene.useCase.data.nodes.map((node) => [node.id, node]));
			const relations: InspectorRelation[] = scene.useCase.data.edges.flatMap((edge) => {
				if (edge.source !== nodeId && edge.target !== nodeId) return [];
				const other = nodes.get(edge.source === nodeId ? edge.target : edge.source);
				return other
					? [{ label: other.attributes.label, nodeId: other.id, relationship: edge.attributes.relationship }]
					: [];
			});
			inspector.showNode(nodeId, scene.graph.getNodePresentation(nodeId), {
				color: nodes.get(nodeId)?.attributes.color ?? null,
				relations,
			});
			return;
		}
		const neighbors = scene.graph.getNeighborIds(nodeId);
		inspector.showNode(nodeId, scene.kind === "stress" ? scene.graph.getNodePresentation(nodeId) : null, {
			color: null,
			extraChips: [`${neighbors.length} neighbors`],
			relations: [],
		});
	}

	/** Depth of field is a no-op in 2D, so the same settings apply to every scene and mode. */
	function applyDepthOfField() {
		stage.current?.graph.setDepthOfField({
			enabled: dofToggle.getAttribute("aria-pressed") === "true",
			strength: Number(dofStrength.value),
		});
	}

	function syncControls() {
		root.dataset.scene = state.scene;
		root.dataset.mode = state.mode;
		history.replaceState(null, "", `${location.pathname}${serializePlaygroundState(state)}${location.hash}`);
		sceneSelect.value = state.scene;
		for (const button of root.querySelectorAll<HTMLButtonElement>("[data-scene-button]")) {
			button.setAttribute("aria-pressed", String(button.dataset.sceneButton === state.scene));
		}
		for (const button of root.querySelectorAll<HTMLButtonElement>("[data-size-button]")) {
			button.setAttribute("aria-pressed", String(Number(button.dataset.sizeButton) === state.size));
		}
		for (const button of root.querySelectorAll<HTMLButtonElement>("[data-mode-button]")) {
			button.setAttribute("aria-pressed", String(button.dataset.modeButton === state.mode));
		}
		// Settings drive the generated stress graph only, so the button is absent on curated scenes.
		for (const button of settingsButtons) button.hidden = state.scene !== "stress";
		if (state.scene !== "stress") toggleSettings(false);
		prove.hidden = !state.prove;
		root.classList.toggle("proving", state.prove);
	}

	function mount() {
		syncControls();
		if (state.scene === "stress") {
			stage.mountStress(state.size, state.mode, new FormData(settings), (nodeId) => select(nodeId));
			inspector.setEntities(null);
			inspector.showScene(sceneById("stress"));
		} else {
			const scene = stage.mountDemo(state.scene as DemoSceneId, state.mode);
			inspector.setEntities(scene.useCase);
			const first = scene.useCase.data.nodes[0];
			select(first?.id ?? null);
		}
		applyDepthOfField();
		resetProve();
	}

	function update(next: Partial<PlaygroundState>) {
		if (proving) return;
		const previous = state;
		state = { ...state, ...next };
		if (state.prove && state.scene !== "stress") state = { ...state, prove: false };
		const onlyModeChanged =
			previous.scene === state.scene && previous.size === state.size && previous.mode !== state.mode;
		if (onlyModeChanged && stage.current?.kind === "demo") {
			syncControls();
			stage.current.graph.setMode(state.mode);
			return;
		}
		if (previous.scene === state.scene && previous.size === state.size && previous.mode === state.mode) {
			syncControls();
			return;
		}
		mount();
	}

	function toggleSettings(open = settings.hidden) {
		settings.hidden = !open;
		for (const button of settingsButtons) button.setAttribute("aria-expanded", String(open));
	}

	function resetProve() {
		proveResult = null;
		proveCopy.disabled = true;
		proveRun.textContent = "Run";
		setProgress("Ready", 0);
		renderProve();
	}

	function setProgress(label: string, progress: number) {
		provePhase.textContent = label;
		provePercent.textContent = progress > 0 ? `${Math.round(progress * 100)}%` : "";
		proveBar.style.width = `${progress * 100}%`;
	}

	function renderProve() {
		const nodes = state.size.toLocaleString();
		const edges = (state.size * 3).toLocaleString();
		proveMeta.textContent = `${nodes} nodes and ${edges} edges in ${state.mode.toUpperCase()}, pixel ratio 1. The reference was measured at 100,000 nodes.`;
		proveKicker.textContent = proveResult ? "Prove · done" : proving ? "Prove · running" : "Prove";
		proveRowsBody.replaceChildren(
			...proveRows(proveResult?.measures ?? null, state.mode, state.size).map((row) => {
				const tr = document.createElement("tr");
				const label = document.createElement("td");
				label.textContent = row.label;
				const you = document.createElement("td");
				you.textContent = row.you;
				you.classList.toggle("faster", row.faster);
				const reference = document.createElement("td");
				reference.textContent = row.reference;
				tr.append(label, you, reference);
				return tr;
			}),
		);
	}

	async function runProveNow() {
		if (proving) return;
		proving = true;
		root.classList.add("busy");
		proveRun.disabled = true;
		proveCopy.disabled = true;
		proveResult = null;
		renderProve();
		stage.clear();
		try {
			const run = await runProve({
				container: stage.container,
				mode: state.mode,
				nodeCount: state.size,
				onPhase: setProgress,
			});
			stage.adoptProveGraph(run.graph);
			proveResult = run;
			proveCopy.disabled = false;
			proveRun.textContent = "Run again";
		} catch (error) {
			setProgress(`Failed: ${error instanceof Error ? error.message : String(error)}`, 0);
		} finally {
			proving = false;
			root.classList.remove("busy");
			proveRun.disabled = false;
			renderProve();
		}
	}

	function renderStatus() {
		const scene = stage.current;
		if (!scene) return;
		const diagnostics = scene.graph.getDiagnostics();
		status.nodes.textContent = `${diagnostics.totalNodes.toLocaleString()} nodes`;
		status.edges.textContent = `${diagnostics.totalEdges.toLocaleString()} edges`;
		status.calls.textContent = `${diagnostics.gpuDrawCalls} draw calls`;
		status.frame.textContent = layoutText || `${diagnostics.cpuFrameMilliseconds.toFixed(1)} ms frame`;
	}

	for (const button of root.querySelectorAll<HTMLButtonElement>("[data-scene-button]")) {
		button.addEventListener("click", () => update({ scene: button.dataset.sceneButton as PlaygroundState["scene"] }));
	}
	sceneSelect.addEventListener("change", () => update({ scene: sceneSelect.value as PlaygroundState["scene"] }));
	for (const button of root.querySelectorAll<HTMLButtonElement>("[data-size-button]")) {
		button.addEventListener("click", () => update({ size: Number(button.dataset.sizeButton) as StressSize }));
	}
	for (const button of root.querySelectorAll<HTMLButtonElement>("[data-mode-button]")) {
		button.addEventListener("click", () => update({ mode: button.dataset.modeButton as GraphraumMode }));
	}
	for (const button of root.querySelectorAll<HTMLButtonElement>("[data-fit]")) {
		button.addEventListener("click", () => stage.current?.graph.fitView());
	}
	for (const button of root.querySelectorAll<HTMLButtonElement>("[data-prove-open]")) {
		button.addEventListener("click", () => update({ prove: true, scene: "stress" }));
	}
	requireElement(prove, "[data-prove-close]").addEventListener("click", () => {
		if (proving) return;
		state = { ...state, prove: false };
		if (stage.current?.kind === "prove") mount();
		else syncControls();
	});
	proveRun.addEventListener("click", () => void runProveNow());
	proveCopy.addEventListener("click", async () => {
		if (!proveResult) return;
		await navigator.clipboard.writeText(proveResult.json);
		proveCopy.textContent = "Copied";
		setTimeout(() => (proveCopy.textContent = "Copy result"), 1200);
	});

	for (const button of settingsButtons) button.addEventListener("click", () => toggleSettings());
	requireElement(settings, "[data-settings-close]").addEventListener("click", () => toggleSettings(false));
	settings.addEventListener("change", () => {
		if (state.scene === "stress" && !proving) mount();
	});

	dofToggle.addEventListener("click", () => {
		dofToggle.setAttribute("aria-pressed", String(dofToggle.getAttribute("aria-pressed") !== "true"));
		applyDepthOfField();
	});
	dofStrength.addEventListener("input", applyDepthOfField);

	requireElement(root, "#code-button").addEventListener("click", () => {
		codeBody.textContent = sceneCode(state.scene);
		codeDialog.showModal();
	});
	requireElement(codeDialog, "[data-code-close]").addEventListener("click", () => codeDialog.close());
	requireElement(codeDialog, "[data-code-copy]").addEventListener("click", () => {
		void navigator.clipboard.writeText(codeBody.textContent ?? "");
	});

	stage.container.addEventListener("click", (event) => {
		const scene = stage.current;
		if (!scene || proving) return;
		if (event.target instanceof HTMLElement && event.target.closest("button")) return;
		toggleSettings(false);
		select(scene.graph.pick(event.clientX, event.clientY));
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") toggleSettings(false);
	});

	window.setInterval(renderStatus, 500);
	window.addEventListener("pagehide", () => stage.destroy(), { once: true });
	mount();
}
