import { defineConfig } from "vitepress";

export default defineConfig({
  title: "RageLayer",
  description: "Turn any web page into a destructible canvas.",
  base: "/RageLayer/",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#171310" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "RageLayer for the web" }],
    [
      "meta",
      {
        property: "og:description",
        content: "Smash, burn, cut, and demolish any page with one npm package.",
      },
    ],
  ],
  sitemap: {
    hostname: "https://parthjadhav.github.io/RageLayer/",
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Integrations", link: "/integrations" },
      { text: "Toolbars", link: "/toolbar" },
      { text: "API", link: "/api" },
      { text: "Compatibility", link: "/compatibility" },
      { text: "Live demo", link: "/demo/" },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "Framework integrations", link: "/integrations" },
          { text: "Compatibility", link: "/compatibility" },
          { text: "Accessibility", link: "/accessibility" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API", link: "/api" },
          { text: "Tool gallery", link: "/tools" },
          { text: "Toolbars, i18n & keyboard", link: "/toolbar" },
          { text: "Procedural 3D models", link: "/models" },
          { text: "Advanced systems", link: "/advanced" },
          { text: "Performance", link: "/performance" },
          { text: "Architecture", link: "/architecture" },
          { text: "Versioning", link: "/versioning" },
          { text: "Releasing", link: "/releasing" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/ParthJadhav/RageLayer" },
      { icon: "npm", link: "https://www.npmjs.com/package/ragelayer" },
    ],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/ParthJadhav/RageLayer/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    outline: [2, 3],
    footer: {
      message: "Released under the MIT License.",
      copyright: "RageLayer by Parth Jadhav",
    },
  },
});
