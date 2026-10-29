/* Part of `npm run build`: ship the tracker minified (~4 KB, ~2 KB gzipped).
   public/t.js stays the readable source. */
import { transform } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const src = await readFile(new URL("../public/t.js", import.meta.url), "utf8");
const { code } = await transform(src, { minify: true, target: "es2015" });
await writeFile(new URL("../dist/t.js", import.meta.url), code);
console.log(`✓ dist/t.js ${(code.length / 1024).toFixed(1)} KB minified`);
