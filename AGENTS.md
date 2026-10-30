# graphraum — repository instructions

This file is the canonical engineering and workflow context for humans and coding agents. Tool-specific files must point here instead of copying these rules.

## Product boundary

graphraum is an opinionated, framework-neutral WebGL engine for interactive node-edge graphs in 2D and 3D.

- `src/` contains the public engine, graph compilation, viewport materialization, picking, updates, and theme contract.
- `docs/` is the Starlight documentation site and executable browser benchmark.
- Layout, graph semantics, labels, accessibility trees, and product actions remain application concerns.
- Preserve the two-draw-call baseline unless a measured, documented trade-off justifies changing it.

## Toolchain

Use Bun for repository work.

```sh
bun install
bun run check
bun run test
bun run test:browser
bun run build
bun run docs:check
bun run docs:test
bun run docs:build
```

Use Vitest for tests. Do not introduce a second formatter, linter, package manager, or test runner.

## Changelog writing

When editing changelogs, follow `.agents/skills/changelog/SKILL.md`:
- use one file per month under `changelogs/YYYY-MM.md`
- use day-level entries inside each monthly file
- keep entries concise and customer facing
- avoid internal engine internals, services, and implementation terms
- include short commit SHAs only when they are helpful
- curate entries instead of dumping commit logs

## Engineering baseline

Apply these in order; later principles never override correctness or a clear public contract.

1. **Correctness and observability:** validate public inputs, fail with actionable errors, dispose resources, and expose consequential renderer decisions through diagnostics.
2. **YAGNI:** implement the smallest capability required by a real use case or benchmark. Do not build speculative abstractions, adapters, or configuration surfaces.
3. **DRY:** keep one source of truth for contracts, theme values, fixture rules, and documentation. Remove duplication when it represents the same decision; do not merge code that merely looks similar.
4. **SOLID, pragmatically:** keep responsibilities focused, extend through narrow contracts, preserve substitutability, expose small interfaces, and point dependencies toward stable graphraum types. Prefer a clear function over a class hierarchy that exists only to demonstrate a principle.
5. **Performance claims require proof:** use the live benchmark and diagnostics. Report fixture size, browser, pixel ratio, protocol, and full result; never generalize one favorable run into a universal claim.

Prefer simple data flow, explicit arguments, immutable public inputs, early guards, and short focused functions. Avoid `any`, non-null assertions, hidden animation loops, per-node objects in the render hot path, and framework-specific state in the core.

## Changes and tests

- Bug fixes require a regression test that fails for the observed cause before the fix.
- Pure helpers and graph compilation logic require focused unit tests.
- Renderer changes require tests for deterministic logic plus a proportionate browser or benchmark check. Shader, draw-order and draw-call changes get a `*.browser.test.ts` that runs in real WebGL2 (`bun run test:browser`, headless Chromium with SwiftShader); assert pixels and diagnostics there, never image snapshots.
- Visual styling is verified manually at desktop and mobile widths; do not add snapshot tests.
- Keep generated output and unrelated working-tree changes out of commits.

## Documentation design

Custom docs surfaces use flat cards with one outer border and edge-to-edge section dividers. Internal sections have no margins, gaps, independent rounding, or shadows; card chrome uses solid fills. Controls and buttons occupy complete card sections. Mark structural components as `not-content` so Starlight prose rhythm cannot create gaps inside them.

## Task tracking

**GitHub Issues are the only task system for this repository.** Every planned change, bug, follow-up, and agent-assigned slice must be a GitHub issue (or an existing one that already covers it). Do not create or update tasks in Linear, Notion, Jira, or any other tracker for graphraum work. Cross-links from other systems to a GitHub issue are fine; the issue itself is the source of truth.

## GitHub workflow

1. Check for an existing GitHub issue; create one with enough context when missing.
2. Branch from current `main` using `feat/`, `fix/`, `docs/`, or `chore/`.
3. Keep commits and pull requests focused.
4. Open a PR with **What / Why or Fix / Verification** and link the GitHub issue.
5. Wait for CI and record follow-up work as GitHub issues instead of expanding scope silently.

## Conventional Commits and releases

Commit messages and PR titles follow:

```text
<type>(<optional-scope>): <imperative summary>
```

Use `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, or `revert`. Keep the header at or below 72 characters. Use `!` or a `BREAKING CHANGE:` footer for an incompatible public contract.

semantic-release runs after a successful push to `main`:

- `fix` and `perf` produce a patch release;
- `feat` produces a minor release;
- breaking changes produce a major release;
- documentation, tests, chores, and refactors do not release unless they carry a breaking-change footer.

Do not manually edit the package version, create release tags, publish the package, or create routine GitHub Releases. semantic-release derives the version from commits, creates the `v<version>` tag and GitHub Release, and publishes `@yggy-tech/graphraum` to npm.
