import { packageName } from "./install-commands";

export interface GraphraumDocsVersion {
	display: string;
	packageSpec: string | null;
	isRelease: boolean;
	referenceUrl: string;
	sourceUrl: string;
}

const repositoryUrl = "https://github.com/yggy-tech/graphraum";
const releasePattern = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const fullGitRevisionPattern = /^[0-9a-f]{40,64}$/;

export function resolveDocsVersion(value?: string, revisionValue?: string): GraphraumDocsVersion {
	const version = value?.trim();
	if (!version) {
		return {
			display: "development",
			packageSpec: null,
			isRelease: false,
			referenceUrl: repositoryUrl,
			sourceUrl: `${repositoryUrl}/tree/main`,
		};
	}
	if (version === "next") {
		const revision = revisionValue?.trim();
		if (!revision || !fullGitRevisionPattern.test(revision)) {
			throw new Error("Next documentation requires a full Git revision");
		}
		return {
			display: "next",
			packageSpec: null,
			isRelease: false,
			referenceUrl: `${repositoryUrl}/commit/${revision}`,
			sourceUrl: `${repositoryUrl}/tree/${revision}`,
		};
	}

	const match = releasePattern.exec(version);
	if (!match?.[1]) throw new Error(`Invalid graphraum docs version: "${version}"`);
	return {
		display: version,
		packageSpec: `${packageName}@${match[1]}`,
		isRelease: true,
		referenceUrl: `${repositoryUrl}/releases/tag/${version}`,
		sourceUrl: `${repositoryUrl}/tree/${version}`,
	};
}

export const graphraumDocsVersion = resolveDocsVersion(
	import.meta.env.GRAPHRAUM_DOCS_VERSION,
	import.meta.env.GRAPHRAUM_DOCS_REVISION,
);
