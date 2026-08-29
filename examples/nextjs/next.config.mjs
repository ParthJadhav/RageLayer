import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {import("next").NextConfig} */
export default {
  // Keep the published package outside Next's application transpilation path.
  transpilePackages: [],
  outputFileTracingRoot: repositoryRoot,
};
