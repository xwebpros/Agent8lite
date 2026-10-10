import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { demoCookie, demoSettings, previewCsrf, verifyPreviewSession } from "../../lib/hosted-demo-access";
import HostedDemo from "../../features/hosted-demo/hosted-demo";
import styles from "../../features/hosted-demo/hosted-demo.module.css";

export const dynamic = "force-dynamic";
export default async function DemoPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const settings = demoSettings();
  if (!settings) notFound();
  const tokens = (await cookies()).getAll(demoCookie);
  if (tokens.length === 1 && verifyPreviewSession(tokens[0].value, settings))
    return <HostedDemo csrf={previewCsrf(tokens[0].value, settings)} />;
  const error = (await searchParams).error === "access";
  return (
    <main className={styles.login}>
      <div className={styles.loginCard}>
        <span className={styles.wordmark}>
          Estate<span> / preview</span>
        </span>
        <h1>Explore your real estate workspace</h1>
        <p>
          A private proof of concept with fictional listings and relationships. Changes are temporary and
          reset when you reload.
        </p>
        <form action="/demo/session" method="post">
          <label htmlFor="preview-password">Preview password</label>
          <input
            id="preview-password"
            name="password"
            type="password"
            autoComplete="current-password"
            minLength={16}
            maxLength={128}
            required
            aria-describedby={error ? "preview-error" : undefined}
          />
          {error && (
            <p id="preview-error" role="alert">
              The preview password was not accepted.
            </p>
          )}
          <button className="button button-primary" type="submit">
            Open demo
          </button>
        </form>
        <p>No real MLS feed, messages or payments are connected.</p>
      </div>
    </main>
  );
}
