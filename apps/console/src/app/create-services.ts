/**
 * Builds the console's long-lived clients from the runtime configuration and wires them together.
 */
import { DEMO_SITE_ID, WsTokenResponseSchema, type RuntimeConfig } from "@mfc/protocol";
import { createAuthClient, type AuthClient } from "../auth/cognito-client";
import { useAuthStore } from "../auth/auth-store";
import { createApiClient, API_PATHS } from "../api/http-client";
import { createWsClient, type WebSocketFactory } from "../ws/ws-client";
import { useWsStore } from "../ws/ws-store";
import { useCommandStore } from "../control/command-store";
import { useLockStore } from "../control/lock-store";
import { useFleetStore } from "../live/fleet-store";
import { publishFrame } from "../live/frame-bus";
import { isFrameForSite } from "../live/frame-site";
import type { Services } from "./services";

/** Clients that replace the production ones. Only the end-to-end build passes them (see `main.tsx`). */
export interface ServicesOverrides {
  /** Replacement authentication client. */
  readonly auth?: AuthClient;
  /** Replacement socket factory. Tests only: production uses the browser WebSocket. */
  readonly createSocket?: WebSocketFactory;
}

/**
 * Creates the clients and connects the auth and realtime state to their stores.
 *
 * The realtime client is created but not connected: the shell connects it once the user is signed in. Every
 * frame updates the live fleet store and is published to the frame bus; every open subscribes to the site.
 *
 * @param config - The validated runtime configuration.
 * @param overrides - Clients that replace the production ones. Empty in production.
 * @returns The services for the component tree.
 */
export function createServices(config: RuntimeConfig, overrides: ServicesOverrides = {}): Services {
  const auth = overrides.auth ?? createAuthClient(config);
  const api = createApiClient(config, auth);

  const ws = createWsClient({
    getWsUrl: () => config.wsUrl,
    createSocket: overrides.createSocket,
    fetchToken: async () => {
      const response = await api.post(
        API_PATHS.wsToken,
        { siteId: DEMO_SITE_ID },
        WsTokenResponseSchema,
      );
      return response.token;
    },
    // Defence in depth: the server already scopes the socket to the subscribed site. A frame for another site
    // is refused here, before the fleet store, the frame bus and the alerts feed see it.
    accepts: (message) => isFrameForSite(message, DEMO_SITE_ID),
    onMessage: (message) => {
      useWsStore.getState().markMessage();
      useFleetStore.getState().applyFrame(message, Date.now());
      // The robot's answer to a command and the lock changes are read from the frames here, so the panel
      // needs no subscription of its own. Each store ignores the frames that are not its own.
      if (message.type === "command.ack") {
        useCommandStore.getState().applyAck(message.ack, performance.now());
      }
      useLockStore.getState().applyFrame(message);
      publishFrame(message);
    },
    // The server sends the fleet snapshot only in answer to a subscription, and forgets it with the socket,
    // so every open (including a reconnection) subscribes again.
    onOpen: () => {
      ws.send({ type: "subscribe", siteId: DEMO_SITE_ID });
    },
  });
  ws.subscribe((state) => {
    useWsStore.getState().setConnection(state);
  });

  auth.onChange((session, reason) => {
    useAuthStore.getState().applySession(session, reason);
    // The control stores hold the previous user's locks and commands. Dropping them at sign-out keeps the next
    // user from seeing them before the first read answers.
    if (session === null) {
      useCommandStore.getState().reset();
      useLockStore.getState().reset();
    }
  });

  return { auth, api, ws, config };
}
