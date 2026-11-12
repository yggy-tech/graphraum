#!/usr/bin/env bash
# Installs the packed tarball into a fresh project, the way a user gets it from npm, then imports it
# in Node and type-checks a consumer under `bundler` and `nodenext` resolution.
set -euo pipefail

root="$(pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

bun pm pack --destination "$work" >/dev/null
cd "$work"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent ./*.tgz typescript@5 @types/three

node --input-type=module -e "
const graphraum = await import('@yggy-tech/graphraum');
if (typeof graphraum.Graphraum !== 'function') throw new Error('Graphraum export missing');
console.log('runtime import ok:', Object.keys(graphraum).length, 'exports');
const diagnostics = await import('@yggy-tech/graphraum/diagnostics');
if (typeof diagnostics.measureLayoutStability !== 'function') throw new Error('diagnostics export missing');
const styles = await import('@yggy-tech/graphraum/styles');
if (!styles.graphraumStylePresets.classicDark) throw new Error('styles export missing');
const layout = await import('@yggy-tech/graphraum/layout');
if (typeof layout.computeForcePositions !== 'function') throw new Error('layout export missing');
const layoutStart = await import('@yggy-tech/graphraum/layout-start');
if (typeof layoutStart.pivotMdsPositions !== 'function') throw new Error('layout-start export missing');
const lod = await import('@yggy-tech/graphraum/lod');
if (typeof lod.buildClusterTree !== 'function' || typeof lod.attachClusterLod !== 'function') throw new Error('lod export missing');
const icons = await import('@yggy-tech/graphraum/icons');
if (typeof icons.createIconAtlas !== 'function' || typeof icons.phosphorIcon !== 'function') throw new Error('icons export missing');
"

cat > consumer.ts <<'TS'
import { Graphraum, type GraphraumData } from "@yggy-tech/graphraum";
import { computeForcePositions } from "@yggy-tech/graphraum/layout";
import { measureLayoutStability } from "@yggy-tech/graphraum/diagnostics";
import { graphraumStylePresets } from "@yggy-tech/graphraum/styles";
import { pivotMdsPositions } from "@yggy-tech/graphraum/layout-start";
import { attachClusterLod, buildClusterTree } from "@yggy-tech/graphraum/lod";
import { createIconAtlas, phosphorIcon } from "@yggy-tech/graphraum/icons";

const data: GraphraumData = {
	nodes: [{ id: "a", position: { x: 0, y: 0 } }],
	edges: [],
};
export function mount(element: HTMLElement) {
	const graph = new Graphraum(element, { mode: "3d", style: graphraumStylePresets.neutral });
	graph.setData(data);
	void measureLayoutStability;
	void createIconAtlas(["<svg/>"]).then((atlas) => graph.setIconAtlas(atlas, { color: "#fff", scale: 0.6 }));
	void phosphorIcon;
	const request = { dimensions: 2 as const, edges: new Uint32Array(), nodeCount: 1 };
	const tree = buildClusterTree({ dimensions: 2, positions: new Float32Array([0, 0]) });
	attachClusterLod(graph, tree, { data, element });
	return computeForcePositions({ ...request, initialPositions: pivotMdsPositions(request) });
}
TS
for resolution in bundler nodenext; do
	module=$([ "$resolution" = bundler ] && echo esnext || echo nodenext)
	npx tsc --noEmit --strict --skipLibCheck false --types three --lib es2022,dom \
		--target es2022 --module "$module" --moduleResolution "$resolution" consumer.ts
	echo "types ok: moduleResolution $resolution"
done
cd "$root"
