"use client";
import { Link } from "../navigation";
import { Layout } from "../components/Layout";
import { useState, type FormEvent } from "react";
import { useLocation } from "../navigation";
import { useTemplateSite } from "../context";
// Preserved account/profile presentation frame; no original identity or profile transport.
type AccountView = {
  user: { id: string; email: string; firstName?: string; lastName?: string; phone?: string };
  tenant?: { name: string } | null;
  roles?: string[];
};
export default function Account() {
  const site = useTemplateSite();
  const [route] = useLocation();
  const verify = route.startsWith("/account/verify");
  const loading = false;
  const [session] = useState<AccountView | null>(null);
  const [profile, setProfile] = useState({ firstName: "", lastName: "", phone: "" });
  const [email, setEmail] = useState("");
  const message =
    "Property browsing and inquiries do not require a visitor account; availability follows the current site/feed policy.";
  const [error, setError] = useState(
    "Native visitor sign-in and profile management are unavailable in this release.",
  );
  const requestLink = (event: FormEvent) => event.preventDefault();
  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    setError("Native visitor profile updates are unavailable. No record changed.");
  };
  const logout = () => setError("Native visitor sessions are unavailable. No session changed.");
  if (loading)
    return (
      <Layout roles={[]}>
        <main className="mx-auto w-full max-w-2xl px-6 py-20">Checking your session...</main>
      </Layout>
    );
  if (verify && error)
    return (
      <Layout roles={[]}>
        <main className="mx-auto w-full max-w-2xl px-6 py-20">
          <h1 className="font-serif text-4xl">Sign-in verification unavailable</h1>
          <p className="mt-4">{error}</p>
          <Link href="/account" className="mt-8 inline-block underline">
            Request a new link
          </Link>
        </main>
      </Layout>
    );
  if (session)
    return (
      <Layout roles={session.roles ?? []}>
        <main className="mx-auto w-full max-w-2xl px-6 py-20">
          <p className="text-sm uppercase tracking-widest text-muted-foreground">VegasIDX account</p>
          <h1 className="mt-3 font-serif text-4xl">Your account</h1>
          <p className="mt-4">Signed in as {session.user.email}</p>
          {session.tenant && <p className="mt-2 text-muted-foreground">Tenant: {session.tenant.name}</p>}
          {session.roles?.length ? (
            <p className="mt-2 text-muted-foreground">Role: {session.roles.join(", ")}</p>
          ) : null}
          {(!session.user.firstName || !session.user.lastName || !session.user.phone) && (
            <form onSubmit={saveProfile} className="mt-8 max-w-md space-y-4 rounded-lg border p-5">
              <h2 className="font-serif text-2xl">Complete your profile</h2>
              <p className="text-sm text-muted-foreground">
                This helps the team follow up on homes you save or view.
              </p>
              <input
                disabled
                aria-label="First name"
                required
                placeholder="First name"
                value={profile.firstName}
                onChange={(event) => setProfile({ ...profile, firstName: event.target.value })}
                className="w-full rounded border px-3 py-2"
              />
              <input
                disabled
                aria-label="Last name"
                required
                placeholder="Last name"
                value={profile.lastName}
                onChange={(event) => setProfile({ ...profile, lastName: event.target.value })}
                className="w-full rounded border px-3 py-2"
              />
              <input
                disabled
                aria-label="Phone number"
                required
                placeholder="Phone number"
                value={profile.phone}
                onChange={(event) => setProfile({ ...profile, phone: event.target.value })}
                className="w-full rounded border px-3 py-2"
              />
              <button disabled className="rounded bg-primary px-4 py-2 text-primary-foreground">
                Save contact information
              </button>
            </form>
          )}
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link href="/workspace" className="rounded bg-primary px-4 py-2 text-primary-foreground">
              Open workspace
            </Link>
            <Link href="/account/favorites" className="underline">
              Saved and viewed homes
            </Link>
            <Link href="/account/organizer" className="underline">
              Property organizer
            </Link>
            <Link href="/" className="underline">
              Browse listings
            </Link>
            <button disabled className="rounded border px-4 py-2" onClick={logout}>
              Sign out
            </button>
          </div>
        </main>
      </Layout>
    );

  return (
    <Layout roles={[]}>
      <main className="mx-auto w-full max-w-2xl px-6 py-20">
        <h1 className="font-serif text-4xl">Sign in to {site.brand.displayName}</h1>
        <p className="mt-4 text-muted-foreground">
          Native visitor sign-in is unavailable in this template release. No sign-in email will be sent.
        </p>
        <form onSubmit={requestLink} className="mt-8 flex max-w-md flex-col gap-4">
          <label htmlFor="account-email">Email address</label>
          <input
            disabled
            id="account-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded border px-3 py-2"
          />
          <button disabled type="submit" className="rounded bg-primary px-4 py-2 text-primary-foreground">
            Email me a sign-in link
          </button>
        </form>
        {message && (
          <p className="mt-4" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="mt-4 text-destructive" role="alert">
            {error}
          </p>
        )}
      </main>
    </Layout>
  );
}
