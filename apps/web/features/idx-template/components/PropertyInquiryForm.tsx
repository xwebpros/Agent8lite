"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import type { components } from "../../../../../packages/contracts/generated/api";
import { templateRequest, TemplateApiError } from "../api";
import { useTemplateSite } from "../context";

export const inquiryFields = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  email: z.string().trim().email("Enter a valid email address.").max(254),
  phone: z.string().trim().max(30).optional(),
  message: z.string().trim().min(1, "Message is required.").max(2000),
});
const inputClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";
type Command = { key: string; body: components["schemas"]["IdxTemplateInquiryWrite"] };
export function PropertyInquiryForm({ listingKey, listingId }: { listingKey: string; listingId?: string }) {
  const site = useTemplateSite();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    message: "I'm interested in this property.",
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [receipt, setReceipt] = useState<components["schemas"]["SubmissionReceipt"] | null>(null);
  const command = useRef<Command | null>(null);
  useEffect(() => {
    if (!pending && !unknown) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const guardLink = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) {
        event.preventDefault();
        event.stopPropagation();
        setError(
          "Reconcile the submitted inquiry before leaving this page. Its original command key is retained in this tab.",
        );
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLink, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardLink, true);
    };
  }, [pending, unknown]);
  const update = (field: keyof typeof form, value: string) => {
    if (!unknown && !pending) {
      setForm((current) => ({ ...current, [field]: value }));
      setError("");
      command.current = null;
    }
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || receipt) return;
    if (!navigator.onLine) {
      setError("Offline. Reconnect before submitting or reconciling this inquiry.");
      return;
    }
    const parsed = inquiryFields.safeParse({ ...form, phone: form.phone || undefined });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please check your inquiry details.");
      return;
    }
    command.current ??= {
      key: crypto.randomUUID(),
      body: {
        ...parsed.data,
        listingKey,
        ...(listingId ? { listingId } : {}),
        formId: site.inquiryForm.id,
        formVersion: site.inquiryForm.version,
      },
    };
    const current = command.current;
    setPending(true);
    setError("");
    try {
      const result = await templateRequest<components["schemas"]["SubmissionReceipt"]>(
        site.siteId,
        "inquiries",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": current.key },
          body: JSON.stringify(current.body),
        },
      );
      if (!result || !/^[0-9a-f-]{36}$/i.test(result.receiptId) || typeof result.message !== "string")
        throw new Error("The durable receipt could not be verified.");
      setReceipt(result);
      setUnknown(false);
    } catch (cause) {
      const uncertain = !(cause instanceof TemplateApiError) || cause.status >= 500 || cause.status === 408;
      setUnknown(uncertain);
      if (!uncertain) command.current = null;
      setError(
        uncertain
          ? "The outcome is unknown. Keep this page open and retry the same inquiry to reconcile it safely."
          : cause instanceof Error
            ? cause.message
            : "Your inquiry could not be received.",
      );
    } finally {
      setPending(false);
    }
  }
  if (receipt)
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
        <p className="font-semibold">Your inquiry was received.</p>
        <p className="mt-1">{receipt.message}</p>
        <p className="mt-2 text-xs">Receipt: {receipt.receiptId}</p>
        {site.dataMode === "mock" && (
          <p className="mt-2 font-medium">Synthetic demonstration: no email or text was sent.</p>
        )}
      </div>
    );
  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-card p-5">
      <div>
        <h3 className="text-xl font-serif font-medium">Ask about this property</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Send an inquiry to {site.brand.agentDisplayName} about this property. No account is required.
        </p>
      </div>
      <fieldset disabled={pending || unknown} className="space-y-4 border-0 p-0">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm font-medium">
            Name <span className="text-destructive">*</span>
            <input
              className={inputClass}
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
              autoComplete="name"
              maxLength={100}
              required
            />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Email <span className="text-destructive">*</span>
            <input
              className={inputClass}
              type="email"
              value={form.email}
              onChange={(event) => update("email", event.target.value)}
              autoComplete="email"
              maxLength={254}
              required
            />
          </label>
        </div>
        <label className="block space-y-1.5 text-sm font-medium">
          Phone <span className="font-normal text-muted-foreground">(optional)</span>
          <input
            className={inputClass}
            type="tel"
            value={form.phone}
            onChange={(event) => update("phone", event.target.value)}
            autoComplete="tel"
            maxLength={30}
          />
        </label>
        <label className="block space-y-1.5 text-sm font-medium">
          Message <span className="text-destructive">*</span>
          <textarea
            className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm md:text-sm"
            value={form.message}
            onChange={(event) => update("message", event.target.value)}
            rows={4}
            maxLength={2000}
            required
          />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-9 items-center justify-center rounded-md border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        {pending ? "Sending inquiry..." : unknown ? "Reconcile the same inquiry" : "Send inquiry"}
      </button>
      <p className="text-xs text-muted-foreground">
        Your inquiry is saved through the site's authorized CRM. This form does not grant marketing consent.
      </p>
    </form>
  );
}
