/**
 * A scripted API and S3 for the component tests of the site sheet. Every request is recorded as its method and
 * path, so a test can assert how many requests of each kind were sent and in which order.
 *
 * The presigned upload and download hosts are answered here too, so the tests never reach a network. The recorded
 * entries carry no URL query, because a presigned URL must never be asserted into a log or a snapshot.
 */
import { DEMO_SITE_ID, SITE_MAP_MAX_BYTES, type MapVersion, type Site } from "@mfc/protocol";
import { vi } from "vitest";
import { TEST_CONFIG } from "../support/console-harness";

/** A handler of one route: it sees the request body text, and answers with a response. */
export type Handler = (body: string) => Response | Promise<Response>;

/** The scripted backend. */
export interface Backend {
  /** The fetch stub to install with `vi.stubGlobal`. */
  readonly fetch: ReturnType<typeof vi.fn>;
  /** Requests received so far, as `METHOD path`, in order. */
  readonly calls: string[];
  /**
   * Replaces the answer of one route.
   *
   * @param route - `METHOD path`, for example `POST /sites/paris-01/maps`.
   * @param handler - The new answer.
   */
  on(route: string, handler: Handler): void;
}

/** Host of the presigned upload and download in the fixtures. */
export const S3_ORIGIN = "https://fleet-maps.s3.eu-west-3.amazonaws.com";

/**
 * Builds a JSON response.
 *
 * @param status - HTTP status.
 * @param body - The JSON body.
 * @returns The response.
 */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The fixture version the reservation answers with. */
const RESERVED_VERSION = 2;

/**
 * A validated version, for the fixtures.
 *
 * @param version - Version number.
 * @param active - Whether it is the active map.
 * @returns The version as the API returns it.
 */
export function versionFixture(
  version: number,
  status: MapVersion["status"],
  active = false,
): MapVersion {
  return {
    version,
    status,
    createdAt: "2026-11-03T10:00:00.000Z",
    createdBy: "e2e-admin",
    sizeBytes: status === "VALID" ? 2048 : null,
    summary:
      status === "VALID"
        ? {
            counts: { wall: 4, obstacle: 1, charger: 1, workstation: 2, nogo: 1 },
            extentM: { x: 10, y: 5 },
          }
        : null,
    active,
  };
}

/**
 * Builds the scripted backend with the happy path already answering: a reservation, an accepted upload, a
 * validation, and an activation.
 *
 * @returns The backend.
 */
export function createBackend(): Backend {
  const calls: string[] = [];
  const routes = new Map<string, Handler>([
    [
      `POST /sites/${DEMO_SITE_ID}/maps`,
      () =>
        jsonResponse(200, {
          version: RESERVED_VERSION,
          upload: {
            url: `${S3_ORIGIN}/`,
            fields: {
              key: `sites/${DEMO_SITE_ID}/maps/${String(RESERVED_VERSION)}.geojson`,
              "Content-Type": "application/geo+json",
            },
            expiresAt: "2026-11-03T10:05:00.000Z",
          },
          maxBytes: SITE_MAP_MAX_BYTES,
        }),
    ],
    [
      `POST /sites/${DEMO_SITE_ID}/maps/${String(RESERVED_VERSION)}/validate`,
      () => jsonResponse(200, versionFixture(RESERVED_VERSION, "VALID")),
    ],
    [
      `POST /sites/${DEMO_SITE_ID}/maps/${String(RESERVED_VERSION)}/activate`,
      () => jsonResponse(200, siteFixture(RESERVED_VERSION)),
    ],
    [`PUT /sites/${DEMO_SITE_ID}`, () => jsonResponse(200, siteFixture(null))],
    // S3 answers a successful presigned POST with 204 No Content.
    [`POST ${S3_ORIGIN}/`, () => new Response(null, { status: 204 })],
  ]);

  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const key = url.origin === S3_ORIGIN ? `${method} ${S3_ORIGIN}/` : `${method} ${url.pathname}`;
    calls.push(key);
    const body = typeof init?.body === "string" ? init.body : "";
    const handler = routes.get(key);
    if (url.origin !== TEST_CONFIG.apiUrl && url.origin !== S3_ORIGIN) {
      return Promise.reject(new Error("unexpected host"));
    }
    return Promise.resolve(handler ? handler(body) : jsonResponse(404, { title: "not found" }));
  });

  return {
    fetch: fetchStub,
    calls,
    on(route, handler) {
      routes.set(route, handler);
    },
  };
}

/**
 * The site profile as the API returns it.
 *
 * @param activeVersion - The active version, or `null`.
 * @returns The site.
 */
export function siteFixture(activeVersion: number | null): Site {
  return {
    siteId: DEMO_SITE_ID,
    name: "Warehouse A",
    activeVersion,
    updatedAt: null,
  };
}
