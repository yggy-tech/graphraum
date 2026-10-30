import { fileURLToPath } from "node:url";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import remarkMermaid from "./src/plugins/remark-mermaid.ts";

const docsThreePath = fileURLToPath(new URL("./node_modules/three", import.meta.url));

export default defineConfig({
	site: "https://yggy-tech.github.io",
	base: "/graphraum",
	integrations: [
		starlight({
			title: "graphraum",
			description: "yggy's WebGL engine for interactive graphs in 2D and 3D.",
			logo: {
				dark: "./src/assets/logo-dark.svg",
				light: "./src/assets/logo-light.svg",
				alt: "",
			},
			customCss: ["./src/styles/custom.css"],
			components: {
				Head: "./src/components/Head.astro",
				SiteTitle: "./src/components/SiteTitle.astro",
			},
			sidebar: [
				{
					label: "Start",
					items: [
						{ label: "Get started", link: "/get-started/" },
						{ label: "Why graphraum", link: "/why-graphraum/" },
					],
				},
				{
					label: "Guide",
					items: [
						{ label: "Data and visuals", link: "/guide/data-and-visuals/" },
						{ label: "Labels and focus", link: "/guide/labels-and-focus/" },
						{ label: "Layout", link: "/guide/layout/" },
						{ label: "Camera and 3D", link: "/guide/camera-and-3d/" },
						{ label: "Theme", link: "/guide/theme/" },
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "API", link: "/reference/api/" },
						{ label: "Architecture", link: "/reference/architecture/" },
						{ label: "Changelog", link: "/reference/changelog/" },
					],
				},
			],
		}),
	],
	// Astro 7's default Markdown processor cannot run remark plugins, so the Mermaid plugin needs the
	// remark-based one. GFM stays explicit: tables, strikethrough and autolinks are used across the docs.
	markdown: { processor: unified({ gfm: true, remarkPlugins: [remarkMermaid] }) },
	vite: {
		resolve: {
			alias: {
				"@yggy-tech/graphraum": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
				three: docsThreePath,
			},
		},
	},
});
