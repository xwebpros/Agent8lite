import type { ReactNode } from "react";
import { InquirySessionProvider } from "../../../../features/idx-template/inquiry-session";

// A layout retains the tab-memory inquiry controller across same-site navigation and refresh.
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  return (
    <InquirySessionProvider key={siteId} siteId={siteId}>
      {children}
    </InquirySessionProvider>
  );
}
