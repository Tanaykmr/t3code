/// <reference lib="dom" />
import { BoatManagedId, type BoatSnapshot, EnvironmentId } from "@t3tools/contracts";
import { expect } from "e2e";

import { startSecondServer } from "./second-server.ts";
import { environmentId, runPromise, test, WEB } from "./t3.ts";

test(
  "A paired Boat guest appears only under Boat machines",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    const controllerOrigin = app.baseUrl ?? "";
    const guest = startSecondServer(controllerOrigin);
    try {
      const { host, token } = await guest.ready;
      const snapshot: BoatSnapshot = {
        account: { status: "configured", label: null },
        rates: [],
        servers: [
          {
            managedId: BoatManagedId.make("managed-scenario"),
            displayName: "Scenario",
            size: "small",
            ttlSeconds: 3600,
            lifecycle: "running",
            operation: null,
            sandboxId: "bx_scenario",
            guestEnvironmentId: EnvironmentId.make(await runPromise(environmentId(host))),
            origin: host,
            observedPower: "running",
            observedAt: null,
            autoStopAt: null,
            retention: "unknown",
            usage: null,
            createdAt: "2026-11-01T00:00:00.000Z",
            lastStartedAt: null,
            lastStoppedAt: null,
          },
        ],
      };
      // Supply the controller's snapshot without provisioning a paid Boat machine.
      await browser.addInitScript(
        ({ controllerHost, snapshot }) => {
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            const request: { _tag: string; id: string; tag: string } | null =
              typeof data === "string" ? JSON.parse(data) : null;
            if (
              request?._tag !== "Request" ||
              request.tag !== "boat.subscribe" ||
              new URL(this.url).host !== controllerHost
            ) {
              return send.call(this, data);
            }
            queueMicrotask(() =>
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    _tag: "Chunk",
                    requestId: request.id,
                    values: [snapshot],
                  }),
                }),
              ),
            );
          };
        },
        { controllerHost: new URL(controllerOrigin).host, snapshot },
      );

      await t3.open("/settings/connections");
      const list = screen.getByRole("button", "List", { exact: true });
      await expect(list).toBeVisible({ timeout: 60_000 });
      await list.tap();
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();

      await expect(screen.getByText(/Connected on this device/)).toBeVisible();
      await app.screenshot("paired-boat-guest");
      await expect(screen.getByRole("button", "More actions for Scenario")).toHaveCount(0);
    } finally {
      await guest.stop();
    }
  },
);
