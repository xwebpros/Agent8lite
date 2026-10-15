"use client";
import { Link } from "../navigation";
import { ArrowLeft } from "lucide-react";
import { Layout } from "../components/Layout";

const retentionRows = [
  ["Sessions and sign-in links", "Awaiting an approved and published tenant retention policy."],
  ["Visitor activity and preferences", "Awaiting an approved and published tenant retention policy."],
  ["Leads, contacts, and real-estate records", "Awaiting an approved and published tenant retention policy."],
  ["Consent and SMS suppression", "Awaiting an approved and published tenant retention policy."],
  ["Messages and delivery events", "Awaiting an approved and published tenant retention policy."],
  [
    "Saved homes, searches, alerts, comparisons, and recommendations",
    "Awaiting an approved and published tenant retention policy.",
  ],
];

export default function Terms() {
  return (
    <Layout>
      <article className="container mx-auto w-full max-w-4xl px-4 py-12 md:px-6 md:py-20">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to search
        </Link>
        <header className="mb-12 max-w-3xl">
          <p className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-primary">
            Tenant legal and retention content requires explicit native CMS approval and publication. The
            imported source policy is retained for review and is not activated on this site.
          </p>
          <h1 className="text-4xl md:text-5xl">Terms and Conditions</h1>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            This section awaits approved tenant content. No source policy or provider-retention claim is
            asserted here.
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            This section awaits approved tenant content. No source policy or provider-retention claim is
            asserted here.
          </p>
        </header>

        <div className="space-y-10 leading-7 text-foreground/85">
          <section aria-labelledby="use-heading">
            <h2 id="use-heading" className="mb-3 text-2xl">
              1. Using the service
            </h2>
            <p>
              This section awaits approved tenant content. No source policy or provider-retention claim is
              asserted here.
            </p>
          </section>

          <section aria-labelledby="accounts-heading">
            <h2 id="accounts-heading" className="mb-3 text-2xl">
              2. Accounts and user content
            </h2>
            <p>
              This section awaits approved tenant content. No source policy or provider-retention claim is
              asserted here.
            </p>
          </section>

          <section aria-labelledby="communications-heading">
            <h2 id="communications-heading" className="mb-3 text-2xl">
              3. Communications and consent
            </h2>
            <p>
              This section awaits approved tenant content. No source policy or provider-retention claim is
              asserted here.
            </p>
          </section>

          <section
            id="retention-privacy"
            aria-labelledby="retention-heading"
            className="scroll-mt-24 rounded-lg border bg-card p-6 md:p-8"
          >
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="mb-2 text-sm font-medium uppercase tracking-[0.15em] text-primary">
                  This section awaits approved tenant content. No source policy or provider-retention claim is
                  asserted here.
                </p>
                <h2 id="retention-heading" className="text-2xl">
                  4. Retention and Privacy Policy
                </h2>
              </div>
              <span className="w-fit rounded-full border px-3 py-1 text-xs text-muted-foreground">
                Awaiting publication
              </span>
            </div>
            <p className="mt-4">
              This section awaits approved tenant content. No source policy or provider-retention claim is
              asserted here.
            </p>
            <div className="mt-6 overflow-x-auto rounded-md border">
              <table className="w-full min-w-[38rem] text-left text-sm">
                <caption className="sr-only">Tenant retention content awaiting publication</caption>
                <thead className="bg-muted/60 text-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Information
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Published handling
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {retentionRows.map(([name, handling]) => (
                    <tr key={name}>
                      <th scope="row" className="px-4 py-3 align-top font-medium">
                        {name}
                      </th>
                      <td className="px-4 py-3 align-top text-muted-foreground">{handling}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-5 text-sm text-muted-foreground">
              This section awaits approved tenant content. No source policy or provider-retention claim is
              asserted here.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              This section awaits approved tenant content. No source policy or provider-retention claim is
              asserted here.
            </p>
          </section>

          <section aria-labelledby="privacy-requests-heading">
            <h2 id="privacy-requests-heading" className="mb-3 text-2xl">
              5. Privacy requests
            </h2>
            <p>
              This section awaits approved tenant content. No source policy or provider-retention claim is
              asserted here.
            </p>
          </section>

          <section aria-labelledby="acceptable-use-heading">
            <h2 id="acceptable-use-heading" className="mb-3 text-2xl">
              6. Acceptable use and availability
            </h2>
            <p>
              This section awaits approved tenant content. No source policy or provider-retention claim is
              asserted here.
            </p>
          </section>

          <section aria-labelledby="changes-heading">
            <h2 id="changes-heading" className="mb-3 text-2xl">
              7. Changes and contact
            </h2>
            <p>
              This section awaits approved tenant content. No source policy or provider-retention claim is
              asserted here.
            </p>
          </section>
        </div>
      </article>
    </Layout>
  );
}
