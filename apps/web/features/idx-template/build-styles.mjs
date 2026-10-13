import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import tailwind from "@tailwindcss/postcss";
const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve("@tailwindcss/postcss"));
const postcss = pluginRequire("postcss");
const base = path.dirname(fileURLToPath(import.meta.url));
let input = await readFile(path.join(base, "provenance/original/index.css.txt"), "utf8");
input = input
  .replace(/^@import url\([^\n]+\);\r?\n/m, "")
  .replace("@import 'leaflet/dist/leaflet.css';", "")
  .replace(
    "@import 'tailwindcss';",
    '@import "tailwindcss" source(none);\n@source "./pages";\n@source "./components";\n@source "./template-app.tsx";\n@source "./context.tsx";\n@source "./inquiry-session.tsx";',
  );
const leaflet = await readFile(
  path.resolve(base, "../../../../node_modules/leaflet/dist/leaflet.css"),
  "utf8",
);
const leafletRoot = path.resolve(base, "../../../../node_modules/leaflet");
const publicAssets = path.resolve(base, "../../public/idx-template-leaflet");
await mkdir(publicAssets, { recursive: true });
const assets = [];
for (const name of [
  "layers.png",
  "layers-2x.png",
  "marker-icon.png",
  "marker-icon-2x.png",
  "marker-shadow.png",
]) {
  const bytes = await readFile(path.join(leafletRoot, "dist/images", name));
  await writeFile(path.join(publicAssets, name), bytes);
  assets.push({ file: name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
}
const license = await readFile(path.join(leafletRoot, "LICENSE"));
await writeFile(path.join(publicAssets, "LICENSE"), license);
await writeFile(
  path.join(publicAssets, "provenance.json"),
  JSON.stringify(
    {
      package: "leaflet",
      version: "1.9.4",
      transformations: [],
      files: assets,
      license: {
        file: "LICENSE",
        sha256: createHash("sha256").update(license).digest("hex"),
        bytes: license.length,
      },
    },
    null,
    2,
  ) + "\n",
);
const result = await postcss([tailwind({ base })]).process(input, {
  from: path.join(base, "template.input.css"),
});
const ast = postcss.parse(result.css + "\n" + leaflet);
ast.walkRules((rule) => {
  if (rule.parent.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
  for (let ancestor = rule.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === "rule") return;
  }
  rule.selectors = rule.selectors.map((selector) => {
    if (selector === ":root" || selector === ":host" || selector === "body" || selector === "html")
      return "[data-idx-template]";
    return "[data-idx-template] " + selector.replace(/\bbody\b/g, "[data-idx-template]");
  });
});
ast.walkDecls((declaration) => {
  if (declaration.prop === "-ms-filter" || declaration.value.includes("progid:")) declaration.remove();
  else declaration.value = declaration.value.replaceAll("url(images/", "url(/idx-template-leaflet/");
});
await writeFile(
  path.join(base, "template.css"),
  "/* Generated from owner source920d148 by build-styles.mjs. Scoped to this template; no external fonts/tiles. */\n" +
    '@font-face { font-family:"DM Sans"; font-style:normal; font-weight:100 1000; font-display:swap; src:url("/fonts/idx-template/dm-sans-variable.ttf") format("truetype"); }\n' +
    '@font-face { font-family:"DM Sans"; font-style:italic; font-weight:100 1000; font-display:swap; src:url("/fonts/idx-template/dm-sans-italic-variable.ttf") format("truetype"); }\n' +
    '@font-face { font-family:"Playfair Display"; font-style:normal; font-weight:400 900; font-display:swap; src:url("/fonts/idx-template/playfair-display-variable.ttf") format("truetype"); }\n' +
    '@font-face { font-family:"Playfair Display"; font-style:italic; font-weight:400 900; font-display:swap; src:url("/fonts/idx-template/playfair-display-italic-variable.ttf") format("truetype"); }\n' +
    ast.toString() +
    '\n[data-idx-template] { font-family: "DM Sans", sans-serif; font-size:16px; line-height:1.5; background:hsl(var(--background)); color:hsl(var(--foreground)); min-height:100dvh; --font-sans:"DM Sans",sans-serif; --font-serif:"Playfair Display",serif; }\n[data-idx-template] h1,[data-idx-template] h2,[data-idx-template] h3,[data-idx-template] h4 { font-family:var(--font-serif); letter-spacing:-.025em; }\n[data-idx-template] a:hover { text-decoration:none; }\n[data-idx-template] .leaflet-container { background:linear-gradient(90deg,transparent 99%,#d6d1c5 99%),linear-gradient(transparent 99%,#d6d1c5 99%),#efede4; background-size:40px 40px; }\n@media (max-width:767px) { [data-idx-template] input:not([type="checkbox"]):not([type="radio"]),[data-idx-template] select,[data-idx-template] textarea { font-size:16px; } [data-idx-template] button:not(.leaflet-control-zoom-in):not(.leaflet-control-zoom-out),[data-idx-template] input:not([type="checkbox"]):not([type="radio"]),[data-idx-template] select { min-height:44px; } }\n',
);
