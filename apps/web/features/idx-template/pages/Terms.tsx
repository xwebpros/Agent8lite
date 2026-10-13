"use client";
import { ArrowLeft } from "lucide-react";
import { Layout } from "../components/Layout";
import { Link } from "../navigation";
export default function Terms() {
  return (
    <Layout>
      <article className="container mx-auto w-full max-w-4xl px-4 py-12 md:px-6 md:py-20">
        <Link href="/" className="mb-8 inline-flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowLeft className="size-4" />
          Back to search
        </Link>
        <header className="mb-12 max-w-3xl">
          <p className="text-xs uppercase tracking-[0.2em] text-primary">Data and use terms</p>
          <h1 className="mt-3 font-serif text-4xl md:text-5xl">Terms and Conditions</h1>
          <p role="status" className="mt-6 text-muted-foreground">
            Published tenant legal and retention content is unavailable in this template release. The imported
            source's proposed policies are preserved for review and are not asserted as this site's adopted
            terms.
          </p>
        </header>
        {["Property data and attribution", "Inquiries and contact information", "Privacy and retention"].map(
          (title) => (
            <section key={title} className="mt-10 border-t pt-8">
              <h2 className="font-serif text-2xl">{title}</h2>
              <p className="mt-4 leading-7 text-muted-foreground">
                This section requires an explicitly approved and published native CMS document.
              </p>
            </section>
          ),
        )}
      </article>
    </Layout>
  );
}
