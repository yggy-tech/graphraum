export const docsBasePath = "/graphraum/";
export const versionSelectorReleaseLimit = 10;

const releaseTagPattern = /^v(\d+)\.(\d+)\.(\d+)$/;
const fullGitRevisionPattern = /^[0-9a-f]{40,64}$/;
const navigationMarker = "graphraum-version-navigation";

export interface RevisionMetadata {
	publishedAt: string;
	revision: string;
	summary: string;
}

export interface ReleaseMetadata extends RevisionMetadata {
	version: string;
}

export function parseReleaseTags(output: string): readonly string[] {
	return output
		.split("\n")
		.map((tag) => ({ match: releaseTagPattern.exec(tag.trim()), tag: tag.trim() }))
		.filter((entry): entry is { match: RegExpExecArray; tag: string } => entry.match !== null)
		.sort((left, right) => {
			for (const index of [1, 2, 3]) {
				const difference = Number(right.match[index]) - Number(left.match[index]);
				if (difference !== 0) return difference;
			}
			return 0;
		})
		.map(({ tag }) => tag);
}

/** How many release versions keep a published docs build. */
export const archivedReleaseLimit = 10;

/**
 * Keeps the newest release of each release line, newest first, up to `limit`.
 * A line is the major version, or the minor version while the major is 0 (where minors break the API).
 * Expects tags sorted newest first, as `parseReleaseTags` returns them.
 */
export function selectArchivedReleases(tags: readonly string[], limit = archivedReleaseLimit): readonly string[] {
	const seenLines = new Set<string>();
	return tags
		.filter((tag) => {
			const match = releaseTagPattern.exec(tag);
			if (!match) return false;
			const line = match[1] === "0" ? `0.${match[2]}` : String(match[1]);
			if (seenLines.has(line)) return false;
			seenLines.add(line);
			return true;
		})
		.slice(0, limit);
}

export function injectVersionNavigation(html: string): string {
	if (html.includes(`data-${navigationMarker}`)) return html;
	return html
		.replace(
			"</head>",
			`<link data-${navigationMarker} rel="stylesheet" href="${docsBasePath}version-selector.css"></head>`,
		)
		.replace(
			"</body>",
			`<script data-${navigationMarker} src="${docsBasePath}version-selector.js" defer></script></body>`,
		);
}

export function createRootRedirect(version: string, relativePath = ""): string {
	const path = relativePath.replace(/^\/+/, "");
	if (path.split("/").includes("..")) throw new Error(`Unsafe documentation redirect path: "${relativePath}"`);
	const target = `${docsBasePath}${version}/${path}`;
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url=${target}">
    <link rel="canonical" href="${target}">
    <title>graphraum ${version}</title>
  </head>
  <body>
    <p>Opening <a href="${target}">graphraum ${version} documentation</a>…</p>
    <script>location.replace(${JSON.stringify(target)} + location.search + location.hash)</script>
  </body>
</html>`;
}

export function createVersionManifest(releases: readonly ReleaseMetadata[], next: RevisionMetadata): string {
	const latest = releases[0]?.version;
	if (!latest) throw new Error("Cannot create a documentation manifest without releases");
	if (!fullGitRevisionPattern.test(next.revision)) {
		throw new Error("Next documentation requires a full Git revision");
	}
	return JSON.stringify(
		{
			archiveHref: `${docsBasePath}versions/`,
			latest,
			selectorVersions: releases.slice(0, versionSelectorReleaseLimit).map(({ version }) => version),
			versions: [
				{
					channel: "development",
					href: `${docsBasePath}next/`,
					publishedAt: next.publishedAt,
					releaseNotes: `https://github.com/yggy-tech/graphraum/compare/${latest}...${next.revision}`,
					revision: next.revision,
					source: `https://github.com/yggy-tech/graphraum/tree/${next.revision}`,
					summary: next.summary,
					version: "next",
				},
				...releases.map(({ publishedAt, revision, summary, version }, index) => ({
					channel: index === 0 ? "latest" : "stable",
					href: `${docsBasePath}${version}/`,
					publishedAt,
					releaseNotes: `https://github.com/yggy-tech/graphraum/releases/tag/${version}`,
					revision,
					source: `https://github.com/yggy-tech/graphraum/tree/${version}`,
					summary,
					version,
				})),
			],
		},
		null,
		2,
	);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function versionArchiveEntry(release: ReleaseMetadata, latest: string): string {
	const version = escapeHtml(release.version);
	const revision = escapeHtml(release.revision);
	const publishedAt = escapeHtml(release.publishedAt);
	const summary = escapeHtml(release.summary);
	const date = publishedAt.slice(0, 10);
	const releaseUrl = `https://github.com/yggy-tech/graphraum/releases/tag/${version}`;
	const sourceUrl = `https://github.com/yggy-tech/graphraum/tree/${version}`;
	const badge = release.version === latest ? "<span>Latest stable</span>" : "<span>Stable</span>";

	return `<article class="release">
      <div class="release-heading">
        <div><h2>${version}</h2>${badge}</div>
        <time datetime="${publishedAt}">${date}</time>
      </div>
      <div class="release-meta">
        <p>${summary}</p>
        <code>${revision.slice(0, 7)}</code>
      </div>
      <nav aria-label="${version} links">
        <a href="${docsBasePath}${version}/">Read docs</a>
        <a href="${releaseUrl}">What changed</a>
        <a href="${sourceUrl}">Source</a>
      </nav>
    </article>`;
}

export function createVersionArchive(releases: readonly ReleaseMetadata[]): string {
	const latest = releases[0]?.version;
	if (!latest) throw new Error("Cannot create a version archive without releases");

	return injectVersionNavigation(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Every immutable graphraum SDK documentation release.">
    <title>graphraum documentation versions</title>
    <style>
      :root {
        --graphraum-border: #cad9d1;
        --graphraum-card: #fcfffc;
        --graphraum-foreground: #040f0f;
        --graphraum-muted: #edf7f2;
        --graphraum-muted-foreground: #456058;
        color-scheme: light dark;
        font-family: "Lexend", system-ui, sans-serif;
      }
      * { box-sizing: border-box; }
      body { background: #fcfffc; color: #040f0f; margin: 0; }
      body > header { align-items: center; border-bottom: 1px solid #cad9d1; display: flex; min-height: 4rem; padding: 0 1.25rem; }
      .site-title { color: inherit; font-size: 1.2rem; font-weight: 800; letter-spacing: -.04em; text-decoration: none; }
      main { margin: clamp(3rem, 8vw, 7rem) auto; max-width: 64rem; padding: 0 1.25rem; }
      main > header { margin-bottom: 2.5rem; max-width: 44rem; }
      h1 { font-size: clamp(2.75rem, 8vw, 6rem); letter-spacing: -.07em; line-height: .95; margin: 0; }
      main > header p { color: #456058; font-size: 1.05rem; line-height: 1.7; margin: 1.25rem 0 0; }
      .releases { border: 1px solid #cad9d1; border-radius: .9rem; overflow: hidden; }
      .release + .release { border-top: 1px solid #cad9d1; }
      .release > * { margin: 0; padding: 1.15rem 1.25rem; }
      .release > * + * { border-top: 1px solid #cad9d1; }
      .release-heading, .release-heading > div, .release-meta, .release nav { align-items: center; display: flex; }
      .release-heading { justify-content: space-between; }
      .release-heading > div { gap: .65rem; }
      h2 { font-size: 1.35rem; letter-spacing: -.04em; margin: 0; }
      .release-heading span { background: #dff1e9; border-radius: 999px; color: #226f54; font-size: .68rem; font-weight: 800; padding: .3rem .5rem; text-transform: uppercase; }
      time, code { color: #456058; font-size: .78rem; }
      .release-meta { justify-content: space-between; gap: 1rem; }
      .release-meta p { margin: 0; }
      .release nav { padding: 0; }
      .release nav a { color: #226f54; flex: 1; font-size: .82rem; font-weight: 800; padding: 1rem 1.25rem; text-align: center; text-decoration: none; }
      .release nav a + a { border-left: 1px solid #cad9d1; }
      .release nav a:hover, .release nav a:focus-visible { background: #edf7f2; }
      @media (prefers-color-scheme: dark) {
        :root {
          --graphraum-border: #26473d;
          --graphraum-card: #040f0f;
          --graphraum-foreground: #fcfffc;
          --graphraum-muted: #0d211b;
          --graphraum-muted-foreground: #a9bdb6;
        }
        body { background: #040f0f; color: #fcfffc; }
        body > header, .releases, .release + .release, .release > * + *, .release nav a + a { border-color: #26473d; }
        main > header p, time, code { color: #a9bdb6; }
        .release-heading span { background: #163d30; color: #8bcab2; }
        .release nav a { color: #8bcab2; }
        .release nav a:hover, .release nav a:focus-visible { background: #0d211b; }
      }
      @media (max-width: 36rem) {
        .release-heading, .release-meta { align-items: flex-start; flex-direction: column; }
        .release nav { align-items: stretch; flex-direction: column; }
        .release nav a + a { border-left: 0; border-top: 1px solid #cad9d1; }
      }
    </style>
  </head>
  <body>
    <header><a class="site-title" href="${docsBasePath}">graphraum</a></header>
    <main>
      <header>
        <h1>Documentation versions</h1>
        <p>Every stable SDK release keeps its own immutable documentation, source, and release notes. The unversioned documentation always opens the latest stable release.</p>
      </header>
      <section class="releases" aria-label="Stable graphraum releases">
        ${releases.map((release) => versionArchiveEntry(release, latest)).join("\n        ")}
      </section>
    </main>
  </body>
</html>`);
}

export function createReleaseFallback(version: string): string {
	const releaseUrl = `https://github.com/yggy-tech/graphraum/releases/tag/${version}`;
	const sourceUrl = `https://github.com/yggy-tech/graphraum/tree/${version}`;
	return injectVersionNavigation(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>graphraum ${version}</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { background: #fcfffc; color: #040f0f; margin: 0; }
      header { align-items: center; border-bottom: 1px solid #cad9d1; display: flex; min-height: 4rem; padding: 0 1.25rem; }
      .site-title { color: inherit; font-size: 1.2rem; font-weight: 800; text-decoration: none; }
      main { margin: 10vh auto; max-width: 48rem; padding: 1.25rem; }
      article { border: 1px solid #cad9d1; border-radius: .8rem; overflow: hidden; }
      article > * { margin: 0; padding: 1.25rem; }
      article > * + * { border-top: 1px solid #cad9d1; }
      h1 { font-size: clamp(2.5rem, 8vw, 5rem); letter-spacing: -.06em; }
      nav { display: grid; grid-template-columns: 1fr 1fr; padding: 0; }
      nav a { color: #226f54; font-weight: 700; padding: 1.25rem; text-decoration: none; }
      nav a + a { border-left: 1px solid #cad9d1; }
      @media (prefers-color-scheme: dark) { body { background: #040f0f; color: #fcfffc; } article, header, nav a + a { border-color: #26473d; } }
    </style>
  </head>
  <body>
    <header><a class="site-title" href="${docsBasePath}${version}/">graphraum</a></header>
    <main>
      <article>
        <h1>${version}</h1>
        <p><strong>Documentation was not shipped with this release.</strong> The SDK remains available through its immutable tag and package release.</p>
        <nav><a href="${releaseUrl}">What changed →</a><a href="${sourceUrl}">Browse SDK source →</a></nav>
      </article>
    </main>
  </body>
</html>`);
}
