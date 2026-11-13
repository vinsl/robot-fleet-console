/**
 * Dependency injection of the console: the clients are created once at boot and read through this context.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { RuntimeConfig } from "@mfc/protocol";
import type { AuthClient } from "../auth/cognito-client";
import type { ApiClient } from "../api/http-client";
import type { WsClient } from "../ws/ws-client";

/** The long-lived clients of the console, and the configuration they were built from. */
export interface Services {
  /** The validated runtime configuration. The video viewer reads its region and pools from here. */
  readonly config: RuntimeConfig;
  /** Sign-in and token management. */
  readonly auth: AuthClient;
  /** REST API calls. */
  readonly api: ApiClient;
  /** Realtime connection. Not connected until a view needs it. */
  readonly ws: WsClient;
}

const ServicesContext = createContext<Services | null>(null);

/** Props of {@link ServicesProvider}. */
export interface ServicesProviderProps {
  /** The clients to expose. */
  readonly value: Services;
  /** The application tree. */
  readonly children: ReactNode;
}

/**
 * Exposes the clients to the component tree.
 *
 * @param props - The clients and the tree.
 * @returns The provider element.
 */
export function ServicesProvider({ value, children }: ServicesProviderProps): ReactNode {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

/**
 * Reads the clients. Must be called under {@link ServicesProvider}.
 *
 * @returns The clients.
 * @throws {Error} When called outside the provider, which is a wiring bug.
 */
export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (services === null) {
    throw new Error("useServices must be used under ServicesProvider");
  }
  return services;
}
