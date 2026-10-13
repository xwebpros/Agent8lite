"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Trash2 } from "lucide-react";
import { Badge, Button } from "../../../packages/ui/components";
import { api } from "../lib/api";
import type { Schema } from "../lib/api";

type PushDevice = Schema<"PushDevice">;
type Props = {
  organizationId: string;
  csrf: string;
  online: boolean;
  working: boolean;
  setWorking(value: boolean): void;
};

const topicLabels: Record<string, string> = {
  assigned_lead: "New lead assignments",
  task_due: "Task due reminders",
  job_failed: "Failed job alerts",
};

export default function PushSettings({ organizationId, csrf, online, working, setWorking }: Props) {
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [permissionState, setPermissionState] = useState<NotificationPermission | "unsupported">(
    "unsupported",
  );
  const epoch = useRef(0);

  useEffect(() => {
    if (typeof Notification !== "undefined") setPermissionState(Notification.permission);
    else setPermissionState("unsupported");
  }, []);

  const [vapidKey, setVapidKey] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/v1/push/vapid-key")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.applicationServerKey) setVapidKey(data.applicationServerKey);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const generation = ++epoch.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<Schema<"PagePushDevice">>(
        `/v1/orgs/${organizationId}/push-subscriptions`,
      );
      if (generation !== epoch.current) return;
      setDevices(result.data.items.filter((d) => d.state === "active"));
    } catch {
      if (generation !== epoch.current) return;
      setDevices([]);
      setError("Could not load push subscriptions.");
    } finally {
      if (generation === epoch.current) setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
    return () => {
      ++epoch.current;
    };
  }, [load]);

  async function registerDevice() {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      if (typeof Notification === "undefined" || !("serviceWorker" in navigator))
        throw new Error("Push notifications are not supported by this browser.");

      const permission = await Notification.requestPermission();
      setPermissionState(permission);
      if (permission !== "granted") throw new Error("Notification permission was denied.");

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          ...(vapidKey ? { applicationServerKey: vapidKey } : {}),
        }));

      const keys = subscription.toJSON().keys;
      if (!keys?.p256dh || !keys?.auth) throw new Error("Push subscription keys are unavailable.");

      const label = [navigator.platform || "", navigator.userAgent.includes("Mobile") ? "Mobile" : "Desktop"]
        .filter(Boolean)
        .join(" ")
        .slice(0, 120) || "Browser device";

      const key = crypto.randomUUID();
      const response = await fetch(`/api/v1/orgs/${encodeURIComponent(organizationId)}/push-subscriptions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "idempotency-key": key,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: { p256dh: keys.p256dh, auth: keys.auth },
          deviceLabel: label,
          topics: ["assigned_lead", "task_due", "job_failed"],
        }),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        throw new Error(problem?.title || `Registration failed (${response.status}).`);
      }

      setNotice("Push notifications enabled for this device.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enable push notifications.");
    } finally {
      setWorking(false);
    }
  }

  async function removeDevice(id: string) {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/v1/orgs/${encodeURIComponent(organizationId)}/push-subscriptions/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "x-csrf-token": csrf },
          credentials: "same-origin",
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Could not remove device (${response.status}).`);
      }
      setNotice("Device removed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove device.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="push-settings">
      <h3>
        <Bell size={18} />
        Push notifications
      </h3>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      <div className="settings-fact">
        <strong>Browser support</strong>
        <Badge tone={permissionState === "unsupported" ? undefined : "positive"}>
          {permissionState === "unsupported" ? "Not supported" : "Available"}
        </Badge>
      </div>
      <div className="settings-fact">
        <strong>Permission</strong>
        <Badge
          tone={
            permissionState === "granted"
              ? "positive"
              : permissionState === "denied"
                ? undefined
                : "warning"
          }
        >
          {permissionState === "unsupported"
            ? "Unavailable"
            : permissionState === "granted"
              ? "Allowed"
              : permissionState === "denied"
                ? "Blocked"
                : "Not asked"}
        </Badge>
      </div>
      {loading ? (
        <p className="muted">Loading registered devices…</p>
      ) : devices.length ? (
        <div className="push-devices">
          {devices.map((device) => (
            <div key={device.id} className="push-device">
              <div>
                <strong>{device.deviceLabel}</strong>
                <span className="muted">
                  {device.topics.map((t) => topicLabels[t] || t).join(", ")}
                </span>
              </div>
              <Button
                variant="secondary"
                disabled={working || !online}
                onClick={() => void removeDevice(device.id)}
                aria-label={`Remove ${device.deviceLabel}`}
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No push subscriptions registered for this device.</p>
      )}
      {permissionState !== "unsupported" && permissionState !== "denied" && (
        <Button
          disabled={working || !online}
          onClick={() => void registerDevice()}
        >
          <Bell size={17} />
          {devices.length ? "Re-register this device" : "Enable push notifications"}
        </Button>
      )}
      {permissionState === "denied" && (
        <p className="muted">
          <BellOff size={15} /> Notification permission is blocked. Use your browser settings to allow
          notifications for this site.
        </p>
      )}
    </div>
  );
}
