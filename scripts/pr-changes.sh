#!/usr/bin/env bash
# Prints GitHub step outputs (code, docs, deps, codeql) for the files a PR changes between two commits.
set -euo pipefail

base="$1"
head="$2"
files="$(git diff --name-only "$base...$head")"

matches() { grep -qE "$1" <<<"$files"; }

workflows=false
matches '^\.github/' && workflows=true

code=false
if [ "$workflows" = true ] ||
	matches '^(src|examples|scripts|etc)/' ||
	matches '^(package\.json|bun\.lock|tsconfig[^/]*\.json|tsdown\.config\.[^/]+|vite[^/]*\.config\.[^/]+|vitest[^/]*\.config\.[^/]+|api-extractor\.json|biome\.json)$'; then
	code=true
fi

# The docs playground imports the library, so a code change rebuilds the docs too.
docs="$code"
matches '^docs/' && docs=true

deps=false
matches '(^|/)(package\.json|bun\.lock)$' && deps=true

languages=()
[ "$code" = true ] && languages+=('"javascript-typescript"')
[ "$workflows" = true ] && languages+=('"actions"')
codeql="[$(IFS=,; echo "${languages[*]:-}")]"

echo "code=$code"
echo "docs=$docs"
echo "deps=$deps"
echo "codeql=$codeql"
