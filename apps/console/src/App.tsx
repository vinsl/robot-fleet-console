/**
 * Root component of the console: wires the clients, the query cache and the router.
 */
import type * as React from "react";
import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { ServicesProvider, type Services } from "./app/services";
import { createQueryClient } from "./app/query-client";
import { createAppRouter } from "./routes";

/** Props of {@link App}. */
export interface AppProps {
  /** The clients created from the runtime configuration. */
  readonly services: Services;
}

/**
 * Renders the console. The query client and the router are created once per page.
 *
 * @param props - The services.
 * @returns The application tree.
 */
export function App({ services }: AppProps): React.JSX.Element {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(createAppRouter);
  return (
    <ServicesProvider value={services}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ServicesProvider>
  );
}
