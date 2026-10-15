"use client";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore, type FormEvent } from "react";
import { useTemplateSite } from "../context";
import { useInquiryRegistry } from "../inquiry-session";
import type { InquiryFields, InquirySnapshot } from "../inquiry-recovery";
export { inquiryFields } from "../inquiry-recovery";

const inputClass =
  "flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:h-9 md:text-sm";
export function PropertyInquiryForm({ listingKey, listingId }: { listingKey: string; listingId?: string }) {
  const site = useTemplateSite();
  const registry = useInquiryRegistry();
  const controller = useMemo(
    () =>
      registry.get({
        siteId: site.siteId,
        listingKey,
        listingId,
        formId: site.inquiryForm.id,
        formVersion: site.inquiryForm.version,
      }),
    [registry, site.siteId, listingKey, listingId, site.inquiryForm.id, site.inquiryForm.version],
  );
  useEffect(
    () =>
      controller.rebind({
        siteId: site.siteId,
        listingKey,
        listingId,
        formId: site.inquiryForm.id,
        formVersion: site.inquiryForm.version,
      }),
    [controller, site.siteId, listingKey, listingId, site.inquiryForm.id, site.inquiryForm.version],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state.error]);
  return (
    <PropertyInquiryFormView
      state={state}
      agentName={site.brand.agentDisplayName}
      synthetic={site.dataMode === "mock"}
      errorRef={errorRef}
      onUpdate={(field, value) => controller.update(field, value)}
      onSubmit={(event) => {
        event.preventDefault();
        void controller.submit(navigator.onLine);
      }}
    />
  );
}

export function PropertyInquiryFormView({
  state,
  agentName,
  synthetic,
  onUpdate,
  onSubmit,
  errorRef,
  idPrefix,
}: {
  state: InquirySnapshot;
  agentName: string;
  synthetic: boolean;
  onUpdate: (field: keyof InquiryFields, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  errorRef?: React.Ref<HTMLParagraphElement>;
  idPrefix?: string;
}) {
  const generatedId = useId();
  const id = idPrefix ?? generatedId;
  const pending = state.phase === "pending";
  const unknown = state.phase === "unknown";
  const attributes = (field: keyof InquiryFields) => ({
    id: `${id}-${field}`,
    name: field,
    "aria-invalid": Boolean(state.fieldErrors[field]),
    ...(state.fieldErrors[field] ? { "aria-describedby": `${id}-${field}-error` } : {}),
  });
  const fieldError = (field: keyof InquiryFields) =>
    state.fieldErrors[field] && (
      <span id={`${id}-${field}-error`} className="block text-sm text-destructive">
        {state.fieldErrors[field]}
      </span>
    );
  if (state.phase === "received" && state.receipt)
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900"
      >
        <p className="font-semibold">Your inquiry was received.</p>
        <p className="mt-1">{state.receipt.message}</p>
        <p className="mt-2 text-xs">Receipt: {state.receipt.receiptId}</p>
        {synthetic && <p className="mt-2 font-medium">Synthetic demonstration: no email or text was sent.</p>}
      </div>
    );
  return (
    <form
      noValidate
      onSubmit={onSubmit}
      aria-busy={pending}
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-privacy`}
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <div>
        <h3 id={`${id}-heading`} className="text-xl font-serif font-medium">
          Ask about this property
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Send an inquiry to {agentName} about this property. No account is required.
        </p>
      </div>
      <fieldset disabled={pending || unknown} className="space-y-4 border-0 p-0">
        <legend className="sr-only">Your inquiry details</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label htmlFor={`${id}-name`} className="space-y-1.5 text-sm font-medium">
            Name{" "}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
            <input
              {...attributes("name")}
              className={inputClass}
              value={state.fields.name}
              onChange={(event) => onUpdate("name", event.target.value)}
              autoComplete="name"
              maxLength={100}
              required
            />
            {fieldError("name")}
          </label>
          <label htmlFor={`${id}-email`} className="space-y-1.5 text-sm font-medium">
            Email{" "}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
            <input
              {...attributes("email")}
              className={inputClass}
              type="email"
              inputMode="email"
              value={state.fields.email}
              onChange={(event) => onUpdate("email", event.target.value)}
              autoComplete="email"
              maxLength={254}
              required
            />
            {fieldError("email")}
          </label>
        </div>
        <label htmlFor={`${id}-phone`} className="block space-y-1.5 text-sm font-medium">
          Phone <span className="font-normal text-muted-foreground">(optional)</span>
          <input
            {...attributes("phone")}
            className={inputClass}
            type="tel"
            inputMode="tel"
            value={state.fields.phone}
            onChange={(event) => onUpdate("phone", event.target.value)}
            autoComplete="tel"
            maxLength={30}
          />
          {fieldError("phone")}
        </label>
        <label htmlFor={`${id}-message`} className="block space-y-1.5 text-sm font-medium">
          Message{" "}
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
          <textarea
            {...attributes("message")}
            className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
            value={state.fields.message}
            onChange={(event) => onUpdate("message", event.target.value)}
            rows={4}
            maxLength={2000}
            required
          />
          {fieldError("message")}
        </label>
      </fieldset>
      {state.error && (
        <p
          ref={errorRef}
          id={`${id}-error`}
          tabIndex={-1}
          role="alert"
          aria-atomic="true"
          className="text-sm text-destructive focus-visible:outline focus-visible:outline-2"
        >
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-primary-border bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover-elevate active-elevate-2"
      >
        {pending ? "Sending inquiry..." : unknown ? "Reconcile the same inquiry" : "Send inquiry"}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {pending
          ? "Sending inquiry. Please wait."
          : unknown
            ? "Inquiry outcome unknown. Your details are locked until the original command is reconciled."
            : ""}
      </span>
      <p id={`${id}-privacy`} className="text-xs text-muted-foreground">
        Your inquiry is saved through the site's authorized CRM. This form does not grant marketing consent.
      </p>
    </form>
  );
}
