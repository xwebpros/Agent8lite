export interface DeliveryRequest {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly eligible: boolean;
  readonly channel: "email" | "sms";
}
export interface DeliveryReceipt {
  readonly attemptId: string;
  readonly state: "simulated" | "suppressed";
  readonly externalDelivery: false;
  readonly providerReference: null;
}
export interface DeliveryTransport {
  deliver(request: DeliveryRequest): Promise<DeliveryReceipt>;
}
