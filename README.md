<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/src/assets/logo-dark.svg">
    <img src="./docs/src/assets/logo-light.svg" alt="graphraum" width="128" height="128">
  </picture>
  <br>
  <strong>graphraum</strong>
  <br>
  <sub>Nodes. Edges. Space.</sub>
</p>

# graphraum

yggy's WebGL engine for interactive node-edge graphs in 2D and 3D.

graphraum renders graphs, accepts positions from any layout engine, and keeps the hot path outside a component framework. Nodes use one instanced mesh, edges use one batched geometry, and rendering happens on demand.

> Pre-1.0 development. The API will continue to evolve while the rendering and visual contracts are proven.

## Principles

- Graph-native data: nodes, edges, stable identities, positions, and selection.
- Native 2D first, with 3D available over the same graph state.
- One node draw call and one edge draw call for the baseline scene.
- Layout is an input, not hidden renderer work.
- Framework adapters belong outside the rendering core.

## Development

Requires [Bun](https://bun.sh/).

```sh
bun install
bun run dev
```

The local graph laboratory exposes every renderer option, theme and visual mapping control, presentation
metadata, diagnostics, and fixture tiers from 100 to 100,000 nodes.

```sh
bun run test
bun run check
bun run build
```

Repository decisions and agent instructions live in [`AGENTS.md`](./AGENTS.md). Changes use [Conventional Commits](https://www.conventionalcommits.org/) and require a matching PR title because squash merges become release commits.

## Install

```sh
npm install @yggy-tech/graphraum
yarn add @yggy-tech/graphraum
pnpm add @yggy-tech/graphraum
bun add @yggy-tech/graphraum
```

Use the line for your package manager.

Publishing is automated with semantic-release after CI succeeds on `main`. Commit types determine the next version, semantic-release creates the `v<version>` tag and GitHub Release, and the package is published to npm. Do not manually edit the package version or create routine release tags.

## Documentation

The [documentation](https://yggy-tech.github.io/graphraum/), [API reference](https://yggy-tech.github.io/graphraum/reference/api/), and the live [playground](https://yggy-tech.github.io/graphraum/playground/) with the Prove benchmark are published on GitHub Pages. Run them locally with:

```sh
bun install --cwd docs
bun run docs:dev
```

## Status

The initial engine includes batched edges, instanced nodes, explicit render scheduling, 2D and 3D cameras, selection colors, picking, fitting, resize handling, and resource disposal. Smooth 2D–3D camera transitions, semantic label LOD, incremental buffer updates, and accessibility adapters remain ahead.

## License

Apache-2.0
