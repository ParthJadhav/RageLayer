import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const forbiddenTracked = trackedFiles.filter(
  (path) =>
    path.startsWith("artifacts/") ||
    /\.(?:mp4|webm|cpuprofile)$/i.test(path) ||
    /\.trace\.json$/i.test(path),
);

const workflowNeedles = ["scripts/tool-demo.mjs", "bun run demo:tools", "artifacts/tool-demo"];
const workflowViolations = [];
for (const path of trackedFiles.filter((path) => path.startsWith(".github/workflows/"))) {
  const source = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) continue;
  for (const needle of workflowNeedles) {
    if (source.includes(needle)) workflowViolations.push(`${path}: ${needle}`);
  }
}

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const publishedArtifacts = (manifest.files ?? []).filter(
  (path) => path === "artifacts" || path.startsWith("artifacts/"),
);

const failures = [
  ...forbiddenTracked.map((path) => `generated artifact is tracked: ${path}`),
  ...workflowViolations.map((detail) => `workflow publishes local demo output: ${detail}`),
  ...publishedArtifacts.map((path) => `npm package includes local artifacts: ${path}`),
];

if (failures.length > 0) {
  throw new Error(`Local artifact boundary failed:\n- ${failures.join("\n- ")}`);
}

console.log("Local demo artifacts are untracked, unpublished, and absent from workflows.");
