# Explorer migration release cut (PRO-385)

Maintainer checklist for the `@yggy-tech/graphraum` npm bump that unlocks the Yggdrasil Graph Lab / Explorer migration.

**Do not bump `package.json` version by hand.** `semantic-release` on `main` owns version, tag, GitHub Release, and publish to npm (see CI `release` job and README Install).

## Blocked by

Merge these to `main` first (either order):

1. **PRO-383** — edge picking + edge selection (`feat/pro-383-edge-picking`)
2. **PRO-384** — viewport-budgeted label layer (PR #89, `feat/pro-384-label-budget`)

This checklist PR can merge after both land; it does not ship the APIs itself.

## Release contents (once 383 + 384 are on main)

Confirm the published package exposes:

| Area | API / contract |
|------|----------------|
| Edge pick + selection | `pickHit`, `setEdgeSelection` |
| Budgeted labels | `autoLabels`, `getLabelCandidates`, `selectBudgetedLabelIds` |
| Existing visuals | Current node/edge presentation contracts already on `main` |

## Cut steps

1. Merge PRO-383 and PRO-384 PRs to `main` (squash; Conventional Commit titles — `feat` drives the minor bump).
2. Curate `changelogs/YYYY-MM.md` for the day of the cut: label budget + edge pick/selection in customer-facing language (see `.agents/skills/changelog/SKILL.md`).
3. Merge this checklist PR (or skip if the changelog was updated on the feature PRs).
4. Wait for CI on `main`: `verify` then `release` (`bun run release` / semantic-release).
5. Confirm the new `v*` tag, GitHub Release notes, and `@yggy-tech/graphraum` on [npm](https://www.npmjs.com/package/@yggy-tech/graphraum).
6. Point Yggdrasil Graph Lab at that version (no local path override).

## Verify install

```sh
bun add @yggy-tech/graphraum@<published-version>
```

## Linear

- [PRO-385](https://linear.app/yggdra/issue/PRO-385/graphraum-release-cut-for-explorer-migration) — this cut
- [PRO-383](https://linear.app/yggdra/issue/PRO-383/graphraum-edge-picking-edge-selection) — blocker
- [PRO-384](https://linear.app/yggdra/issue/PRO-384/graphraum-viewport-budgeted-label-layer) — blocker
