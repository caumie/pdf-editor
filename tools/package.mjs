// Ship only the source, built HTML, tests and project files; no local tools or artifacts.
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "build-output"));
const { zipSync } = createRequire(import.meta.url)("../src/vendor/fflate/index.js");
const entries = Object.create(null);
const roots = ["src", "tests", "tools"];
const projectFiles = [
  "README.md", "pdf-editor-screenshot.png", "Dockerfile", ".gitignore", ".dockerignore",
  "package.json", "package-lock.json", "playwright.config.mjs", "dist/pdf-editor.html",
];
async function add(file) {
  entries["pdf-editor/" + file] = await readFile(join(root, file));
}
async function addTree(directory) {
  for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory + "/" + item.name;
    if (item.isDirectory()) await addTree(path);
    else if (item.isFile()) await add(path);
  }
}
for (const directory of roots) await addTree(directory);
for (const file of projectFiles) await add(file);
await mkdir(output, { recursive: true });
for (const [input, target] of [
  ["dist/pdf-editor.html", "pdf-editor.html"],
  ["README.md", "README.md"],
  ["pdf-editor-screenshot.png", "pdf-editor-screenshot.png"],
]) await copyFile(join(root, input), join(output, target));
const archive = join(output, "pdf-editor-source.zip");
await writeFile(archive, zipSync(entries, { level: 6 }));
console.log(archive);
