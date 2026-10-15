import { describe, expect, it, vi } from "vitest";
import {
  InquiryRecoveryController,
  InquiryRecoveryRegistry,
  InquiryResponseError,
  type InquiryBinding,
  type InquiryCommand,
} from "./inquiry-recovery";

const binding: InquiryBinding = {
  siteId: "11111111-1111-4111-8111-111111111111",
  listingKey: "SYNTHETIC-NEVER-LIVE-001",
  formId: "22222222-2222-4222-8222-222222222222",
  formVersion: 3,
};
const receipt = { receiptId: "33333333-3333-4333-8333-333333333333", message: "Inquiry recorded." };
function fill(controller: InquiryRecoveryController) {
  controller.update("name", "Synthetic Visitor");
  controller.update("email", "visitor@example.invalid");
  controller.update("phone", "+1 555 010 0000");
  controller.update("message", "A synthetic property inquiry; no delivery requested.");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}
describe("public inquiry recovery", () => {
  it("single-flights overlapping submissions and rejects edits while a command is in flight", async () => {
    const result = deferred<unknown>();
    const transport = vi.fn((_command: InquiryCommand) => result.promise);
    const keys = vi.fn(() => "44444444-4444-4444-8444-444444444444");
    const controller = new InquiryRecoveryController(binding, transport, keys);
    fill(controller);
    const first = controller.submit(true);
    const overlapping = controller.submit(true);
    controller.update("message", "Changed after submission");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(keys).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("pending");
    expect(transport.mock.calls[0][0].body.message).toContain("synthetic property inquiry");
    result.resolve(receipt);
    await Promise.all([first, overlapping]);
    expect(controller.getSnapshot().phase).toBe("received");
    expect(controller.getSnapshot().fields.email).toBe("");
    expect(controller.hasDirtyDraft).toBe(false);
    await controller.submit(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("reconciles a committed command after response loss with the identical key, body and published form version", async () => {
    const ledger = new Map<string, { body: string; receipt: typeof receipt }>();
    const seen: InquiryCommand[] = [];
    const transport = async (command: InquiryCommand) => {
      seen.push(command);
      const previous = ledger.get(command.key);
      if (previous) {
        expect(JSON.stringify(command.body)).toBe(previous.body);
        return previous.receipt;
      }
      ledger.set(command.key, { body: JSON.stringify(command.body), receipt });
      throw new Error("Simulated response loss after durable acceptance");
    };
    const keys = vi.fn(() => "44444444-4444-4444-8444-444444444444");
    const controller = new InquiryRecoveryController(binding, transport, keys);
    fill(controller);
    await controller.submit(true);
    expect(controller.getSnapshot().phase).toBe("unknown");
    controller.update("name", "An edited visitor");
    controller.rebind({ ...binding, formVersion: 9, formId: "55555555-5555-4555-8555-555555555555" });
    await controller.submit(true);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[1].body.formVersion).toBe(3);
    expect(seen[1].body.name).toBe("Synthetic Visitor");
    expect(ledger.size).toBe(1);
    expect(keys).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().receipt).toEqual(receipt);
  });

  it("does not abandon an uncertain key when later access revocation or expiry denies reconciliation", async () => {
    const transport = vi
      .fn<(command: InquiryCommand) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockRejectedValueOnce(new InquiryResponseError(403, "Access revoked"))
      .mockRejectedValueOnce(new InquiryResponseError(410, "Published form expired"))
      .mockResolvedValueOnce(receipt);
    const controller = new InquiryRecoveryController(binding, transport);
    fill(controller);
    for (let attempt = 0; attempt < 3; attempt++) {
      await controller.submit(true);
      expect(controller.getSnapshot().phase).toBe("unknown");
    }
    await controller.submit(true);
    expect(new Set(transport.mock.calls.map(([command]) => command.key)).size).toBe(1);
    expect(controller.getSnapshot().phase).toBe("received");
  });

  it.each([408, 409, 425, 429, 500, 503])("retains an uncertain command for HTTP %i", async (status) => {
    const transport = vi.fn(async (_command: InquiryCommand) => {
      throw new InquiryResponseError(status, "Retry outcome uncertain");
    });
    const controller = new InquiryRecoveryController(binding, transport);
    fill(controller);
    await controller.submit(true);
    expect(controller.getSnapshot().phase).toBe("unknown");
    await controller.submit(true);
    expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0]);
  });

  it("permits reviewed correction after a definite first rejection, using a new command and current form revision", async () => {
    const transport = vi
      .fn<(command: InquiryCommand) => Promise<unknown>>()
      .mockRejectedValueOnce(new InquiryResponseError(422, "Please correct the inquiry."))
      .mockResolvedValueOnce(receipt);
    const keys = vi
      .fn()
      .mockReturnValueOnce("44444444-4444-4444-8444-444444444444")
      .mockReturnValueOnce("55555555-5555-4555-8555-555555555555");
    const controller = new InquiryRecoveryController(binding, transport, keys);
    fill(controller);
    await controller.submit(true);
    expect(controller.getSnapshot().phase).toBe("editing");
    controller.update("message", "A reviewed correction");
    controller.rebind({ ...binding, formVersion: 4 });
    await controller.submit(true);
    expect(transport.mock.calls[1][0].key).not.toBe(transport.mock.calls[0][0].key);
    expect(transport.mock.calls[1][0].body).toMatchObject({
      message: "A reviewed correction",
      formVersion: 4,
    });
  });

  it("never queues offline mutations or replaces an uncertain command while offline", async () => {
    const transport = vi
      .fn<(command: InquiryCommand) => Promise<unknown>>()
      .mockRejectedValue(new Error("Response lost"));
    const keys = vi.fn(() => "44444444-4444-4444-8444-444444444444");
    const controller = new InquiryRecoveryController(binding, transport, keys);
    fill(controller);
    await controller.submit(false);
    expect(transport).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    await controller.submit(true);
    await controller.submit(false);
    expect(controller.getSnapshot().phase).toBe("unknown");
    expect(transport).toHaveBeenCalledTimes(1);
    await controller.submit(true);
    expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0]);
  });

  it.each([
    null,
    { receiptId: "not-a-uuid", message: "Accepted" },
    { receiptId: receipt.receiptId },
    { receiptId: "------------------------------------", message: "Accepted" },
  ])("does not claim completion for a malformed successful response %j", async (response) => {
    const controller = new InquiryRecoveryController(binding, async () => response);
    fill(controller);
    await controller.submit(true);
    expect(controller.getSnapshot().phase).toBe("unknown");
    expect(controller.getSnapshot().receipt).toBeNull();
  });

  it("validates fields before creating a command and reports every invalid field", async () => {
    const transport = vi.fn(async () => receipt);
    const controller = new InquiryRecoveryController(binding, transport);
    controller.update("message", " ");
    await controller.submit(true);
    expect(transport).not.toHaveBeenCalled();
    expect(controller.getSnapshot().fieldErrors).toEqual({
      name: expect.any(String),
      email: expect.any(String),
      message: expect.any(String),
    });
    fill(controller);
    await controller.submit(true);
    expect(controller.getSnapshot().phase).toBe("received");
  });

  it("keeps drafts and unknown commands across consumer remounts while rejecting another site scope", async () => {
    const transport = vi
      .fn<(command: InquiryCommand) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValueOnce(receipt);
    const registry = new InquiryRecoveryRegistry(binding.siteId, transport);
    const first = registry.get(binding);
    fill(first);
    expect(registry.get(binding).getSnapshot().fields.email).toBe("visitor@example.invalid");
    await first.submit(true);
    const remounted = registry.get({ ...binding, formVersion: 10 });
    expect(remounted).toBe(first);
    remounted.rebind({ ...binding, formVersion: 10 });
    await remounted.submit(true);
    expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0]);
    expect(() => registry.get({ ...binding, siteId: "different-site" })).toThrow("site scope");
    expect(() => first.rebind({ ...binding, listingKey: "different-listing" })).toThrow("scope");
  });
});
