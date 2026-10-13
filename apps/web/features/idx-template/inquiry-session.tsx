"use client";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { TemplateApiError, templateRequest } from "./request";
import { InquiryRecoveryRegistry, InquiryResponseError } from "./inquiry-recovery";

const InquiryContext = createContext<InquiryRecoveryRegistry | null>(null);
export function useInquiryRegistry() {
  const registry = useContext(InquiryContext);
  if (!registry) throw new Error("Site-scoped inquiry session is required.");
  return registry;
}
export function InquirySessionProvider({ siteId, children }: { siteId: string; children: ReactNode }) {
  const [registry] = useState(
    () =>
      new InquiryRecoveryRegistry(siteId, async (command) => {
        try {
          return await templateRequest(command.siteId, "inquiries", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": command.key },
            body: JSON.stringify(command.body),
          });
        } catch (cause) {
          if (cause instanceof TemplateApiError) throw new InquiryResponseError(cause.status, cause.message);
          throw cause;
        }
      }),
  );
  const revision = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  useEffect(() => {
    if (!registry.all().some((controller) => controller.hasDirtyDraft || controller.hasUnresolvedCommand))
      return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const guardLink = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("a[href]")) return;
      const unresolved = registry.all().filter((controller) => controller.hasUnresolvedCommand);
      if (!unresolved.length) return;
      event.preventDefault();
      event.stopPropagation();
      for (const controller of unresolved) controller.explainNavigationGuard();
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardLink, true);
    };
  }, [registry, revision]);
  return (
    <InquiryContext.Provider value={registry}>
      {children}
      {registry.all().some((controller) => controller.getSnapshot().phase !== "editing") && (
        <div data-idx-template className="idx-template min-h-0 px-4 pb-6">
          <OfflineInquiryRecovery />
        </div>
      )}
    </InquiryContext.Provider>
  );
}

/** Recovery does not redisplay expired property data, and never creates another command key. */
export function OfflineInquiryRecovery() {
  const registry = useInquiryRegistry();
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const commands = registry.all().filter((controller) => controller.getSnapshot().phase !== "editing");
  if (!commands.length) return null;
  return (
    <section
      aria-label="Inquiry recovery"
      className="mt-6 space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 className="font-serif text-xl">Your inquiry remains in this tab</h2>
      {commands.map((controller, index) => {
        const state = controller.getSnapshot();
        return (
          <div key={index}>
            {state.phase === "received" && state.receipt ? (
              <p role="status">Inquiry received. Receipt: {state.receipt.receiptId}</p>
            ) : (
              <>
                <p role="status">
                  {state.phase === "pending"
                    ? "Checking the submitted inquiry..."
                    : "The outcome is unknown. Reconnect and check the original inquiry before reloading."}
                </p>
                {state.error && (
                  <p role="alert" className="mt-2 text-sm text-destructive">
                    {state.error}
                  </p>
                )}
                <button
                  type="button"
                  disabled={state.phase === "pending"}
                  className="mt-3 min-h-11 rounded bg-primary px-5 py-3 text-primary-foreground disabled:opacity-50"
                  onClick={() => void controller.submit(navigator.onLine)}
                >
                  Check inquiry outcome
                </button>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
