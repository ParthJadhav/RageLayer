import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "react/index": "src/react/index.ts",
  },
  format: ["esm"],
  dts: true,
  minify: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom"],
});
