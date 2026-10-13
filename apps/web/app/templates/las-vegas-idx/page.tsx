import Link from "next/link";
export const metadata = { title: "Las Vegas IDX templates", robots: { index: false, follow: false } };
export default function TemplateGallery() {
  const example = process.env.IDX_TEMPLATE_EXAMPLE_SITE_ID;
  return (
    <main style={{ padding: "4rem 1.5rem", maxWidth: "52rem", margin: "auto" }}>
      <h1>Las Vegas IDX website templates</h1>
      <p>
        The original public search, gallery, filters, map layout and inquiry design are available as native
        agent and brokerage templates.
      </p>
      <p>
        Create and edit a site in Agent8lite's content studio, then explicitly publish its revision. Public
        visitors receive published content and currently permitted listing data.
      </p>
      <p>
        Synthetic demonstrations are visibly labeled. Live MLS, map tiles and delivery require their
        independent account and acceptance gates.
      </p>
      {example && /^[0-9a-f-]{36}$/i.test(example) ? (
        <Link href={`/templates/las-vegas-idx/${example}`}>Open the configured published example</Link>
      ) : (
        <p>No published example is configured on this server.</p>
      )}
      <p>
        <Link href="/websites">Open native website management</Link>
      </p>
    </main>
  );
}
