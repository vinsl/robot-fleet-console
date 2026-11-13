/**
 * Site configuration API: route builders and react-query hooks for the site profile and its map versions.
 *
 * The routes are built from validated identifiers and version numbers only, so a value from the UI can
 * never add a path segment. The demo runs one site, so every call uses {@link DEMO_SITE_ID}, the same
 * constant the WebSocket token request uses.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreateMapResponseSchema,
  DEMO_SITE_ID,
  MapVersionNumberSchema,
  MapUrlResponseSchema,
  MapVersionSchema,
  MapVersionsResponseSchema,
  SiteIdSchema,
  SiteSchema,
  type MapVersion,
  type MapUrlResponse,
  type MapVersionNumber,
  type Site,
  type SiteId,
  type UpdateSiteRequest,
} from "@mfc/protocol";
import { useServices } from "../app/services";
import type { ApiClient, SitePath } from "./http-client";

/** Query key prefix of the site profile. */
const SITE_KEY = "site";

/** Query key prefix of the map version list. */
const MAPS_KEY = "site-maps";

/**
 * Query key prefix of the downloaded map bodies. Written by `useSiteMap` in `site/use-site-map.ts`, and
 * declared here so that the write hooks can invalidate it: the body of `active` changes on activation.
 */
export const SITE_MAP_BODY_KEY = "site-map";

/**
 * Checks a site identifier before it becomes a path segment.
 *
 * @param siteId - Candidate identifier.
 * @returns The identifier, unchanged.
 * @throws TypeError When the identifier does not match the protocol grammar.
 */
function checkedSiteId(siteId: SiteId): SiteId {
  if (!SiteIdSchema.safeParse(siteId).success) {
    throw new TypeError("invalid site id");
  }
  return siteId;
}

/**
 * Checks a map reference before it becomes a path segment.
 *
 * @param version - A version number, or `active` for the map the site uses.
 * @returns The path segment.
 * @throws TypeError When the version is not a valid version number.
 */
function versionSegment(version: MapVersionNumber | "active"): string {
  if (version === "active") {
    return version;
  }
  if (!MapVersionNumberSchema.safeParse(version).success) {
    throw new TypeError("invalid map version");
  }
  return String(version);
}

/** Builders of the site routes. Each returns a path the HTTP client accepts. */
export const sitePaths = {
  /**
   * @param siteId - Site identifier.
   * @returns `/sites/{siteId}`.
   */
  site: (siteId: SiteId): SitePath => `/sites/${checkedSiteId(siteId)}`,
  /**
   * @param siteId - Site identifier.
   * @returns `/sites/{siteId}/maps`.
   */
  maps: (siteId: SiteId): SitePath => `/sites/${checkedSiteId(siteId)}/maps`,
  /**
   * @param siteId - Site identifier.
   * @param version - Version number, or `active`.
   * @returns `/sites/{siteId}/maps/{version}`.
   */
  map: (siteId: SiteId, version: MapVersionNumber | "active"): SitePath =>
    `/sites/${checkedSiteId(siteId)}/maps/${versionSegment(version)}`,
  /**
   * @param siteId - Site identifier.
   * @param version - Version number to validate.
   * @returns `/sites/{siteId}/maps/{version}/validate`.
   */
  validate: (siteId: SiteId, version: MapVersionNumber): SitePath =>
    `/sites/${checkedSiteId(siteId)}/maps/${versionSegment(version)}/validate`,
  /**
   * @param siteId - Site identifier.
   * @param version - Version number to activate.
   * @returns `/sites/{siteId}/maps/{version}/activate`.
   */
  activate: (siteId: SiteId, version: MapVersionNumber): SitePath =>
    `/sites/${checkedSiteId(siteId)}/maps/${versionSegment(version)}/activate`,
};

/**
 * Reads the site profile.
 *
 * @returns The query result of `GET /sites/{siteId}`.
 */
export function useSite() {
  const { api } = useServices();
  return useQuery({
    queryKey: [SITE_KEY, DEMO_SITE_ID],
    queryFn: () => api.get(sitePaths.site(DEMO_SITE_ID), SiteSchema),
  });
}

/**
 * Reads the map versions. Only the Admin role may list them, so the caller enables the query for Admin
 * only; a disabled query sends nothing.
 *
 * @param enabled - Whether to fetch the list.
 * @returns The query result of `GET /sites/{siteId}/maps`.
 */
export function useMapVersions(enabled: boolean) {
  const { api } = useServices();
  return useQuery({
    queryKey: [MAPS_KEY, DEMO_SITE_ID],
    queryFn: () => api.get(sitePaths.maps(DEMO_SITE_ID), MapVersionsResponseSchema),
    enabled,
  });
}

/**
 * Requests a presigned download of one map version, or of the active one.
 *
 * @param api - The API client.
 * @param version - Version number, or `active`.
 * @returns The validated presigned download.
 */
export function fetchMapUrl(
  api: ApiClient,
  version: MapVersionNumber | "active",
): Promise<MapUrlResponse> {
  return api.get(sitePaths.map(DEMO_SITE_ID, version), MapUrlResponseSchema);
}

/**
 * Builds the success handler of a write: invalidates the site profile, the version list and the downloaded
 * map bodies, so every screen shows the new state.
 *
 * @returns A function that invalidates the query keys.
 */
function useInvalidateSite(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [SITE_KEY] }),
      queryClient.invalidateQueries({ queryKey: [MAPS_KEY] }),
      queryClient.invalidateQueries({ queryKey: [SITE_MAP_BODY_KEY] }),
    ]);
  };
}

/**
 * Reserves an upload slot for a new map version.
 *
 * @returns The mutation; it resolves with the slot (version and presigned POST).
 */
export function useCreateMap() {
  const { api } = useServices();
  const invalidate = useInvalidateSite();
  return useMutation({
    mutationFn: () => api.post(sitePaths.maps(DEMO_SITE_ID), undefined, CreateMapResponseSchema),
    onSuccess: invalidate,
  });
}

/**
 * Validates an uploaded map version.
 *
 * @returns The mutation; it takes the version number and resolves with the validated version.
 */
export function useValidateMap() {
  const { api } = useServices();
  const invalidate = useInvalidateSite();
  return useMutation({
    mutationFn: (version: MapVersionNumber): Promise<MapVersion> =>
      api.post(sitePaths.validate(DEMO_SITE_ID, version), undefined, MapVersionSchema),
    onSuccess: invalidate,
  });
}

/**
 * Makes a validated map version the active one.
 *
 * @returns The mutation; it takes the version number and resolves with the updated site.
 */
export function useActivateMap() {
  const { api } = useServices();
  const invalidate = useInvalidateSite();
  return useMutation({
    mutationFn: (version: MapVersionNumber): Promise<Site> =>
      api.post(sitePaths.activate(DEMO_SITE_ID, version), undefined, SiteSchema),
    onSuccess: invalidate,
  });
}

/**
 * Renames the site.
 *
 * @returns The mutation; it takes the new profile and resolves with the stored site.
 */
export function useUpdateSite() {
  const { api } = useServices();
  const invalidate = useInvalidateSite();
  return useMutation({
    mutationFn: (request: UpdateSiteRequest): Promise<Site> =>
      api.put(sitePaths.site(DEMO_SITE_ID), request, SiteSchema),
    onSuccess: invalidate,
  });
}
