"use client";
import { Link } from "../navigation";
import { Layout } from "../components/Layout";
export default function Account() {
  return (
    <Layout roles={[]}>
      <main className="mx-auto w-full max-w-2xl px-6 py-20">
        <h1 className="font-serif text-4xl">Your property account</h1>
        <p className="mt-4 text-muted-foreground">
          Sign in to manage saved homes and searches through the native visitor service.
        </p>
        <form className="mt-8 flex max-w-md flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="template-account-email">Email address</label>
          <input id="template-account-email" type="email" disabled className="rounded border px-3 py-2" />
          <button type="submit" disabled className="rounded bg-primary px-4 py-2 text-primary-foreground">
            Email me a sign-in link
          </button>
        </form>
        <p role="status" className="mt-4 text-muted-foreground">
          Visitor sign-in is unavailable in this template release. No sign-in email will be sent. Browsing and
          property inquiries remain available.
        </p>
        <div className="mt-8 flex flex-wrap gap-4">
          <Link href="/" className="underline">
            Browse listings
          </Link>
          <Link href="/workspace" className="underline">
            Agent8lite workspace sign-in
          </Link>
        </div>
      </main>
    </Layout>
  );
}
