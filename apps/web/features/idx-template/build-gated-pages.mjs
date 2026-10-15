import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const base = path.dirname(fileURLToPath(import.meta.url));
const original = async (name) =>
  (await readFile(path.join(base, `provenance/original/pages/${name}.tsx.txt`), "utf8")).replaceAll(
    "\r\n",
    "\n",
  );
const imports =
  '"use client";\nimport { Link } from "../navigation";\nimport { Layout } from "../components/Layout";\n';

let account = await original("Account");
account = account.slice(account.indexOf("  if (loading) return <Layout"));
account = account
  .replace("Sign in to VegasIDX", "Sign in to {site.brand.displayName}")
  .replace("Sign-in link expired", "Sign-in verification unavailable")
  .replace(
    "We will email you a secure, one-time sign-in link.",
    "Native visitor sign-in is unavailable in this template release. No sign-in email will be sent.",
  )
  .replaceAll("<input ", "<input disabled ")
  .replaceAll("<button ", "<button disabled ");
await writeFile(
  path.join(base, "pages/Account.tsx"),
  imports +
    'import { useState, type FormEvent } from "react";\nimport { useLocation } from "../navigation";\nimport { useTemplateSite } from "../context";\n// Preserved account/profile presentation frame; no original identity or profile transport.\ntype AccountView={user:{id:string;email:string;firstName?:string;lastName?:string;phone?:string};tenant?:{name:string}|null;roles?:string[]};\nexport default function Account() {\nconst site=useTemplateSite(); const [route]=useLocation();const verify=route.startsWith("/account/verify"); const loading=false;const [session]=useState<AccountView|null>(null);const [profile,setProfile]=useState({firstName:"",lastName:"",phone:""});\nconst [email,setEmail]=useState(""); const message="Property browsing and inquiries do not require a visitor account; availability follows the current site/feed policy."; const [error,setError]=useState("Native visitor sign-in and profile management are unavailable in this release."); const requestLink=(event:FormEvent)=>event.preventDefault();const saveProfile=(event:FormEvent)=>{event.preventDefault();setError("Native visitor profile updates are unavailable. No record changed.");};const logout=()=>setError("Native visitor sessions are unavailable. No session changed.");\n' +
    account,
);

let organizer = await original("Organizer");
const helpers = organizer.slice(
  organizer.indexOf("function summary("),
  organizer.indexOf("export default function Organizer"),
);
organizer = organizer.slice(
  organizer.indexOf('  return <Layout><main className="mx-auto w-full max-w-5xl px-4 py-14'),
);
organizer = organizer
  .replaceAll('type="button"', 'type="button" disabled')
  .replaceAll("<select ", "<select disabled ")
  .replaceAll('type="checkbox"', 'type="checkbox" disabled')
  .replace("{comparison?.items.length ?? 0} / 4", "Unavailable · 4 maximum")
  .replace("No saved searches yet.", "Native visitor saved searches are unavailable in this release.")
  .replace(
    "Add properties from listing cards to compare them here.",
    "Native property comparisons are unavailable in this release.",
  )
  .replace(
    "Live listings matched to your saved property activity.",
    "Permitted listings matched to your saved property activity when this capability is enabled.",
  )
  .replace(
    "Live recommendations are unavailable right now. Your organizer data is still available.",
    "Recommendations are unavailable. No property preferences have been inferred.",
  )
  .replace("No preferences inferred yet.", "Property preference inference is unavailable in this release.")
  .replace(
    "No notification preferences configured.",
    "Native visitor notification preferences are unavailable. No message has been scheduled.",
  )
  .replace(
    "No listing alerts yet.",
    "Licensed listing alerts are unavailable. No email or SMS has been sent.",
  )
  .replace(
    '{profile?.inferenceEnabled === false ? "Enable inference" : "Disable inference"}',
    '{profile ? profile.inferenceEnabled === false ? "Enable inference" : "Disable inference" : "Inference unavailable"}',
  );
const organizerModels = `import { useState } from "react";
import { ListingCard } from "../components/ListingCard";
import type { Listing, ListListingsParams as SavedSearchCriteria } from "../api";
import type { components } from "../../../../../packages/contracts/generated/api";
// Local render models for preserved source panels; no transport, inference or simulated API exists.
type SearchRow = Omit<components["schemas"]["SavedSearch"], "criteria"> & {criteria:SavedSearchCriteria;enabled:boolean;alertFrequency:string;alertChannel:string};
type Comparison = {items:Array<{id:string;listingKey:string}>};
type Profile = {version:number;inferenceEnabled:boolean;preferences:Array<{dimension:string;value:string|number|boolean;source:string;confidence:number;evidence:Array<{source:string}>}>};
type Preference = {category:string;channel:string;enabled:boolean};
type Alert = {id:string;alertType:string;listingKey:string;deliveryStatus:string;detectedAt:string};
${helpers}
export default function Organizer() {
const [notice,setNotice]=useState("Native visitor organizer capabilities are unavailable in this release.");
const [searches]=useState<SearchRow[]>([]); const [comparison]=useState<Comparison|null>(null); const [resolved]=useState(new Map<string,Listing>());
const [profile]=useState<Profile|null>(null);const [preferences]=useState<Preference[]>([]);const [alerts]=useState<Alert[]>([]);
const [recommendations]=useState<{items:Listing[];reasons:string[]}|null>(null);
const unavailable=(..._input:unknown[])=>setNotice("This native visitor capability is unavailable. No customer state or messages changed.");
const updateAlertSettings=unavailable,editCriteria=unavailable,renameSearch=unavailable,toggleSearch=unavailable,removeSearch=unavailable,removeComparison=unavailable,toggleInference=unavailable,resetPreferences=unavailable,togglePreference=unavailable;
`;
await writeFile(path.join(base, "pages/Organizer.tsx"), imports + organizerModels + organizer);

let location = await original("LocationPage");
const locationModels = location.slice(
  location.indexOf("type LocationPageData"),
  location.indexOf("const money"),
);
location = location.slice(location.indexOf("  const { location, marketSummary } = data;"));
location = location
  .replaceAll("Live IDX snapshot", "IDX snapshot")
  .replaceAll("No live snapshot available", "No current snapshot available")
  .replace(
    "The live IDX snapshot is temporarily unavailable. Browse the search page to retry when the feed is available.",
    "Native market statistics are unavailable. No unverified totals or prices are shown.",
  )
  .replace("window.location.origin", "origin")
  .replace(
    "JSON.stringify(locationStructuredData(location, origin))",
    'JSON.stringify(locationStructuredData(location, origin)).replaceAll("<", "\\\\u003c")',
  )
  .replace(
    "locationStructuredData(location, origin)",
    "locationStructuredData(location, origin, `/templates/las-vegas-idx/${site.siteId}`)",
  );
await writeFile(
  path.join(base, "pages/LocationPage.tsx"),
  imports +
    'import { ArrowRight, ChevronRight, ExternalLink } from "lucide-react";\nimport { useRoute } from "../navigation";\nimport { useTemplateSite,useTemplateOrigin } from "../context";\nimport { locationPagePath, locationStructuredData, publicLocations } from "../lib/location-seo";\n' +
    locationModels +
    'const money = new Intl.NumberFormat("en-US", {style:"currency",currency:"USD",maximumFractionDigits:0});\nexport default function LocationPage() {\nconst [,params]=useRoute<{slug:string}>("/communities/:slug");const site=useTemplateSite();const origin=useTemplateOrigin();const selected=publicLocations.find(item=>item.slug===params?.slug);\nconst data:LocationPageData={location:{slug:selected?.slug??"unavailable",displayName:selected?.displayName??"Location",cityFilter:selected?.displayName??"",title:site.seo.title,description:site.seo.description,intro:site.content.exploreDescription,faqs:[{question:"Is a current market snapshot available?",answer:"The native market-statistics capability is unavailable. Use explicit property filters to review permitted listings."}]},marketSummary:null,marketDataStatus:"unavailable"};\n' +
    location,
);

let terms = await original("Terms");
terms = terms
  .replaceAll('"wouter"', '"../navigation"')
  .replaceAll('"@/components/Layout"', '"../components/Layout"');
const categories = [...terms.matchAll(/\["([^"\n]+)",/g)].map((match) => match[1]);
terms = terms.replace(
  /const retentionRows = \[[\s\S]*?\n\];/,
  "const retentionRows = " +
    JSON.stringify(
      categories.map((name) => [name, "Awaiting an approved and published tenant retention policy."]),
    ) +
    ";",
);
let paragraph = 0;
terms = terms.replace(
  /<p([^>]*)>[\s\S]*?<\/p>/g,
  (_full, attributes) =>
    `<p${attributes}>${paragraph++ === 0 ? "Tenant legal and retention content requires explicit native CMS approval and publication. The imported source policy is retained for review and is not activated on this site." : "This section awaits approved tenant content. No source policy or provider-retention claim is asserted here."}</p>`,
);
terms = terms
  .replace("Case-by-case handling", "Awaiting publication")
  .replaceAll("Proposed retention schedule", "Tenant retention content awaiting publication")
  .replaceAll("Proposed handling", "Published handling");
await writeFile(path.join(base, "pages/Terms.tsx"), '"use client";\n' + terms);

let saved = await original("SavedHomes");
saved = saved.slice(saved.indexOf("  const section = (title:"));
saved = saved
  .replace('{entries.length} {entries.length === 1 ? "home" : "homes"}', "Unavailable")
  .replace(
    "No homes here yet.",
    "Native visitor saved-home and view-history capabilities are unavailable in this release.",
  )
  .replace(
    "Your saved homes follow your account, so they are available after you sign in on another browser or device.",
    "Saved homes require a verified native visitor account. Private property activity is not stored on this device.",
  );
await writeFile(
  path.join(base, "pages/SavedHomes.tsx"),
  imports +
    'import { useState } from "react";\nimport { FavoriteButton } from "../components/FavoriteButton";\nimport type { Listing } from "../api";\ntype FavoriteEntry={listingKey:string;createdAt:string;updatedAt:string};\ntype ViewEntry={listingKey:string;firstViewedAt:string;lastViewedAt:string};\nexport default function SavedHomes(){\nconst [favorites]=useState<FavoriteEntry[]>([]);const [views]=useState<ViewEntry[]>([]);const [listings]=useState(new Map<string,Listing>());const [unavailable]=useState(new Set<string>());\n' +
    saved,
);
