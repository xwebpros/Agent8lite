import type { components } from "../generated/api";

/** Internal pure preparation only. These values never establish session, host or publication authority. */
export type CmsPublicationPreparationInputV1 = Readonly<{
  schemaVersion: 1;
  command: Readonly<components["schemas"]["PublishRequest"]>;
  site: Readonly<components["schemas"]["Site"]>;
  document: Readonly<components["schemas"]["Document"]>;
  revision: Readonly<components["schemas"]["Revision"]>;
  revisionContentHash: string;
  target: Readonly<{
    mode: "synthetic";
    origin: string;
    bindingVersion: number;
  }>;
  policy: Readonly<{
    code: "native-text-links-v1";
    rendererVersion: "1.0.0";
    approvedLinkOrigins: readonly string[];
  }>;
}>;

/** Detached immutable public-content candidate; a later authorized atomic release is still mandatory. */
export type PreparedCmsPublicationV1 = Readonly<{
  schemaVersion: 1;
  synthetic: true;
  siteId: string;
  documentId: string;
  revisionId: string;
  expectedDocumentVersion: number;
  nextDocumentVersion: number;
  bindingVersion: number;
  origin: string;
  route: string;
  canonicalUrl: string;
  title: string;
  kind: components["schemas"]["Document"]["kind"];
  themeVersion: string;
  seo: Readonly<components["schemas"]["Seo"]>;
  contentHash: string;
  policyCode: "native-text-links-v1";
  rendererVersion: "1.0.0";
  policyHash: string;
  html: string;
  htmlHash: string;
  headers: Readonly<{
    "Cache-Control": "no-store";
    "Content-Type": "text/html; charset=utf-8";
    "Content-Security-Policy": string;
    "X-Content-Type-Options": "nosniff";
    "Referrer-Policy": "no-referrer";
  }>;
}>;
