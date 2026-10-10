export interface UploadGrantBinding {
  readonly tenantId: string;
  readonly memberId: string;
  readonly assetId: string;
  readonly objectKey: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly expiresAt: string;
}
export interface PrivateObjectStore {
  issueUploadGrant(binding: UploadGrantBinding): { signature: string };
  verifyUploadGrant(signature: string, binding: UploadGrantBinding): void;
  putOnce(tenantId: string, objectKey: string, data: Buffer): Promise<void>;
  read(tenantId: string, objectKey: string): Promise<Buffer>;
  putPrivateResult(tenantId: string, objectKey: string, data: Buffer): Promise<void>;
}
export class StorageError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
