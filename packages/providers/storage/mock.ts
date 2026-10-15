import type { StoragePort, StorageUploadGrant, StorageUploadRequest } from "./port";

const UPLOAD_TTL_SECONDS = 3600;

/** Synthetic loopback-only storage for development and test. The PUT target is served by the API's /dev/uploads endpoint. */
export class MockStorageProvider implements StoragePort {
  constructor(private readonly devApiOrigin: string) {}

  async createUploadGrant(request: StorageUploadRequest): Promise<StorageUploadGrant> {
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString();
    return {
      url: `${this.devApiOrigin}/dev/uploads/${request.assetId}`,
      method: "PUT",
      expiresAt,
      requiredHeaders: {
        "Content-Type": request.mimeType,
        "Content-Length": request.bytes,
      },
    };
  }
}
