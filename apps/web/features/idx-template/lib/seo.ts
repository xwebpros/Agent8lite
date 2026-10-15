export function setPageMetadata(_input: {
  title: string;
  description: string;
  path?: string;
  type?: string;
}) {
  /* Metadata is produced by the server from the published revision; listing fields are never injected into document.head by a late client response. */
}
