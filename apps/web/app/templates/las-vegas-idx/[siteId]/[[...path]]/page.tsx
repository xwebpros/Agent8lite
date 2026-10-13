import type { Metadata } from "next";
import { headers } from "next/headers";
import IdxTemplateApp from "../../../../../features/idx-template/template-app";
import { getPublishedIdxTemplateContent, idxTemplateWebOrigin } from "../../../../../lib/idx-template-server";

type Props = { params: Promise<{ siteId: string; path?: string[] }> };
async function content(siteId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new Error("Published site identifier required.");
  const requestHeaders = await headers();
  const origin = idxTemplateWebOrigin(requestHeaders.get("host"));
  return getPublishedIdxTemplateContent(siteId, origin);
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const { siteId } = await params;
    const site = await content(siteId);
    return {
      title: site.seo.title,
      description: site.seo.description,
      robots: { index: !site.seo.noindex, follow: !site.seo.noindex },
      openGraph: { title: site.seo.title, description: site.seo.description },
      ...(site.seo.canonicalPath ? { alternates: { canonical: site.seo.canonicalPath } } : {}),
    };
  } catch {
    return { title: "Published IDX site unavailable", robots: { index: false, follow: false } };
  }
}
export default async function TemplatePage({ params }: Props) {
  try {
    const { siteId, path } = await params;
    const site = await content(siteId);
    const origin = idxTemplateWebOrigin((await headers()).get("host"));
    return <IdxTemplateApp site={site} path={path} origin={origin} />;
  } catch {
    return (
      <main style={{ padding: "4rem 1.5rem", maxWidth: "48rem", margin: "auto" }}>
        <h1>Published site unavailable</h1>
        <p>
          This site has no currently authorized published template, or its service is unavailable. Draft
          content and private records are not shown.
        </p>
        <a href="/templates/las-vegas-idx">Return to the template gallery</a>
      </main>
    );
  }
}
