import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("bun", ["run", "build"]);

const publicDir = resolve(root, "docs/public");
const publicDemo = resolve(publicDir, "demo");
const publicDist = resolve(publicDir, "dist");
const publicScreenshots = resolve(publicDir, "screenshots");
rmSync(publicDemo, { recursive: true, force: true });
rmSync(publicDist, { recursive: true, force: true });
rmSync(publicScreenshots, { recursive: true, force: true });
mkdirSync(publicDemo, { recursive: true });
cpSync(resolve(root, "demo/index.html"), resolve(publicDemo, "index.html"));
cpSync(resolve(root, "dist"), publicDist, { recursive: true });
cpSync(resolve(root, "docs/screenshots"), publicScreenshots, { recursive: true });

try {
  run("bunx", ["vitepress", "build", "docs"]);
} finally {
  rmSync(publicDemo, { recursive: true, force: true });
  rmSync(publicDist, { recursive: true, force: true });
  rmSync(publicScreenshots, { recursive: true, force: true });
}

console.log("Documentation site built with the live demo and local package bundle.");
