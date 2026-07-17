#!/usr/bin/env node
/**
 * Build multi-tab grentify examples site into ./site
 *
 * Tabs: TodoMVC · elm-syntax · elm-review (style rules on ported syntax AST)
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const localGren =
  path.join(root, "node_modules", ".bin", "gren") +
  (process.platform === "win32" ? ".cmd" : "");
const gren = fs.existsSync(localGren) ? localGren : "gren";

function run(cwd, args) {
  console.log("+", "gren", args.join(" "), `(${path.relative(root, cwd)})`);
  const r = spawnSync(gren, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const site = path.join(root, "site");
for (const dir of ["todo", "syntax", "review"]) {
  fs.mkdirSync(path.join(site, dir), { recursive: true });
}

run(path.join(root, "examples", "gallery"), [
  "make",
  "Main",
  "--output=" + path.join(site, "index.html"),
]);
const todoHtml = path.join(site, "todo", "index.html");
run(path.join(root, "example-project"), [
  "make",
  "Main",
  "--output=" + todoHtml,
]);
fs.copyFileSync(
  path.join(root, "example-project", "style.css"),
  path.join(site, "todo", "style.css"),
);
// TodoMVC FOUC: app shell starts with visibility:hidden until CSS applies
// `.todomvc-wrapper { visibility: visible !important }`. Relative href
// "style.css" resolves to /style.css (404) when the URL is /todo with no
// trailing slash, so inject a root-absolute stylesheet in <head>.
{
  let html = fs.readFileSync(todoHtml, "utf8");
  const inject =
    '<link rel="stylesheet" href="/todo/style.css">\n' +
    "  <style>.todomvc-wrapper { visibility: visible !important; }</style>";
  if (!html.includes('href="/todo/style.css"')) {
    html = html.replace(
      "<style>body { padding: 0; margin: 0; }</style>",
      "<style>body { padding: 0; margin: 0; }</style>\n  " + inject,
    );
    fs.writeFileSync(todoHtml, html);
  }
}
run(path.join(root, "example-project-syntax-review"), [
  "make",
  "Main",
  "--output=" + path.join(site, "syntax", "index.html"),
]);
run(path.join(root, "example-project-review"), [
  "make",
  "Main",
  "--output=" + path.join(site, "review", "index.html"),
]);

console.log("site ready:", site);
