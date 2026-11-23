import esbuild from "esbuild"
import builtins from "builtin-modules"
import { copyFileSync } from "node:fs"

const production = process.argv.includes("production")

const result = esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  // Obsidian 运行时自带这些模块，必须 external，否则会出现
  // 两份 CodeMirror 实例：Unrecognized extension value in extension set
  external: [
    "obsidian",
    "electron",
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
    "@codemirror/commands",
    "@codemirror/search",
    "@codemirror/autocomplete",
    "@codemirror/lint",
    "@codemirror/collab",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  outfile: "main.js",
})

result.then(() => {
  if (production) {
    copyFileSync("manifest.json", "manifest.json")
  }
}).catch(() => process.exit(1))
