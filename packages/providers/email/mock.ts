import type { DeliveryRequest, DeliveryReceipt, DeliveryTransport } from "./port";

/** No network, recipients or message bodies. It cannot send a real communication. */
export class NoDeliveryTransport implements DeliveryTransport {
  private readonly receipts = new Map<string, { input: string; receipt: DeliveryReceipt }>();
  async deliver(request: DeliveryRequest): Promise<DeliveryReceipt> {
    if (!request.tenantId || !request.attemptId || !request.idempotencyKey)
      throw new Error("Verified delivery references are required.");
    const key = JSON.stringify([request.tenantId, request.idempotencyKey]);
    const input = JSON.stringify(request);
    const existing = this.receipts.get(key);
    if (existing && existing.input !== input) throw new Error("DELIVERY_IDEMPOTENCY_CONFLICT");
    if (existing) return structuredClone(existing.receipt);
    const receipt: DeliveryReceipt = {
      attemptId: request.attemptId,
      state: request.eligible ? "simulated" : "suppressed",
      externalDelivery: false,
      providerReference: null,
    };
    this.receipts.set(key, { input, receipt });
    return structuredClone(receipt);
  }
}
