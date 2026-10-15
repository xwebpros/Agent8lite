import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const base = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const manifest = JSON.parse(await readFile(path.join(base, "source-parity.json"), "utf8"));
for (const file of manifest.files) {
  const bytes = await readFile(path.join(base, "provenance/original", `${file.path}.txt`));
  if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error(`Source parity mismatch: ${file.path}`);
}
const files = [
  "pages/Home.tsx",
  "pages/ListingDetail.tsx",
  "pages/LocationPage.tsx",
  "pages/SavedHomes.tsx",
  "pages/Organizer.tsx",
  "pages/Account.tsx",
  "pages/Terms.tsx",
  "components/Layout.tsx",
  "components/ListingCard.tsx",
  "components/Filters.tsx",
  "components/ListingMap.tsx",
  "components/MapListingPreview.tsx",
  "components/IdxAttribution.tsx",
  "components/PropertyInquiryForm.tsx",
  "components/NaturalLanguageSearch.tsx",
  "components/FavoriteButton.tsx",
  "components/OrganizerActions.tsx",
  "lib/content.ts",
  "lib/events.ts",
  "lib/seo.ts",
  "api.ts",
  "request.ts",
  "inquiry-recovery.ts",
  "inquiry-session.tsx",
  "context.tsx",
  "navigation.tsx",
  "template-app.tsx",
];
for (const file of files) {
  const code = await readFile(path.join(base, file), "utf8");
  if (
    /@workspace\/api-client-react|localStorage|sessionStorage|tile\.openstreetmap|TRESTLE_CLIENT|DIRECTUS|\/api\/leads|\/api\/auth\//.test(
      code,
    )
  )
    throw new Error(`Legacy provider or private persistence in active source: ${file}`);
}
for (const page of ["Organizer", "Terms", "LocationPage"]) {
  const original = await readFile(path.join(base, `provenance/original/pages/${page}.tsx.txt`), "utf8");
  const adapted = await readFile(path.join(base, `pages/${page}.tsx`), "utf8");
  for (const match of original.matchAll(/aria-labelledby="([^"]+)"/g)) {
    if (!adapted.includes(`aria-labelledby="${match[1]}"`))
      throw new Error(`Source section was lost: ${page}/${match[1]}`);
  }
}
const css = await readFile(path.join(base, "template.css"), "utf8");
postcss.parse(css).walkRules((rule) => {
  if (rule.parent.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
  for (let ancestor = rule.parent; ancestor; ancestor = ancestor.parent) if (ancestor.type === "rule") return;
  if (rule.selectors.some((selector) => !selector.startsWith("[data-idx-template]")))
    throw new Error(`Unscoped template CSS: ${rule.selector}`);
});
postcss.parse(css).walkDecls((declaration) => {
  if (/url\s*\(\s*["']?https?:\/\//.test(declaration.value))
    throw new Error("Template CSS cannot request external fonts or tiles.");
  if (/url\s*\(\s*["']?images\//.test(declaration.value))
    throw new Error("Leaflet images must use self-hosted absolute public URLs.");
});
const assets = JSON.parse(
  await readFile(path.resolve(base, "../../public/idx-template-leaflet/provenance.json"), "utf8"),
);
if (assets.package !== "leaflet" || assets.version !== "1.9.4" || assets.files.length !== 5)
  throw new Error("Unexpected Leaflet provenance.");
for (const asset of [...assets.files, assets.license]) {
  const bytes = await readFile(path.resolve(base, "../../public/idx-template-leaflet", asset.file));
  if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error(`Leaflet asset mismatch: ${asset.file}`);
}
console.log(
  JSON.stringify({
    originalFiles: manifest.files.length,
    activeFiles: files.length,
    originalCommit: manifest.commit,
    scopedCss: true,
    privatePersistence: false,
    legacyClientImports: false,
  }),
);
