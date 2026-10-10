"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../packages/ui/components";
import StaffConsole from "./staff-console";
import styles from "./staff-console.module.css";

/** Separate staff identity surface. Every private value stays inside the console's memory. */
export default function StaffWorkspace({ syntheticFeaturesEnabled }: { syntheticFeaturesEnabled: boolean }) {
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const protectedReload = useRef(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [activated, setActivated] = useState(false);
  const accepted = useRef(false);
  const recoveryChanged = useCallback((value: boolean) => {
    protectedReload.current = value;
    setRecoveryRequired(value);
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let active = true;
    let registration: ServiceWorkerRegistration | undefined;
    const observe = () => {
      const worker = registration?.installing;
      worker?.addEventListener("statechange", () => {
        if (active && worker.state === "installed" && navigator.serviceWorker.controller) setWaiting(worker);
      });
    };
    const changed = () => {
      if (!accepted.current) return;
      if (protectedReload.current) setActivated(true);
      else window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((value) => {
        if (!active) return;
        registration = value;
        if (value.waiting) setWaiting(value.waiting);
        value.addEventListener("updatefound", observe);
      })
      .catch(() => {});
    return () => {
      active = false;
      registration?.removeEventListener("updatefound", observe);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
    };
  }, []);

  return (
    <>
      <a className="skip-link" href="#staff-main">
        Skip to staff console
      </a>
      <main id="staff-main" className={styles.console}>
        <header>
          <h1>Synthetic staff console</h1>
          <p>Separate staff sign-in and explicit local organization provisioning.</p>
          <a href="/">Return to member workspace</a>
        </header>
        {(waiting || activated) && (
          <section aria-label="Application update">
            <p role="status">
              {recoveryRequired
                ? "Finish or reconcile the current draft and operations before updating this app."
                : "An app update is available."}
            </p>
            <Button
              disabled={recoveryRequired}
              onClick={() => {
                if (protectedReload.current) return;
                if (activated) window.location.reload();
                else if (waiting) {
                  accepted.current = true;
                  waiting.postMessage({ type: "SKIP_WAITING" });
                }
              }}
            >
              {activated ? "Reload updated app" : "Apply app update"}
            </Button>
          </section>
        )}
        <StaffConsole
          syntheticFeaturesEnabled={syntheticFeaturesEnabled}
          onRecoveryRequired={recoveryChanged}
        />
      </main>
    </>
  );
}
