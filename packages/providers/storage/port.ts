export type StorageUploadRequest = {
  assetId: string;
  mimeType: string;
  bytes: number;
  purposeKey: string;
};
export type StorageUploadGrant = {
  url: string;
  method: "PUT";
  expiresAt: string;
  requiredHeaders: Record<string, string | number | boolean>;
};
export type StoragePort = {
  createUploadGrant(request: StorageUploadRequest): Promise<StorageUploadGrant>;
};
