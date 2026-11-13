/**
 * Versions tab of the site sheet (Admin only): every map version of the site, its status, and the actions the
 * status allows.
 *
 * The list is the operator's view of the server: a version is shown as `PENDING` or `VALID`, and only a `VALID`
 * version can be activated or downloaded. Each action is a separate request with its own failure message, and
 * activation asks for a second press, because it changes what the planner drives on.
 */
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, Clock, Download, Eye, ShieldCheck } from "lucide-react";
import type { MapVersion, MapVersionNumber } from "@mfc/protocol";
import { fetchMapUrl, useActivateMap, useMapVersions, useValidateMap } from "../../api/site";
import { useServices } from "../../app/services";
import { useAuthStore } from "../../auth/auth-store";
import { activationFailureKey, type ActivationFailureKey } from "../activation";
import { useSiteMap } from "../use-site-map";
import { classNames } from "../../lib/class-names";
import { featureLayers } from "../render/map-geometry";
import { MapLegend } from "../render/MapLegend";
import { SiteMapView } from "../render/SiteMapView";
import editorStyles from "../editor/Editor.module.css";
import styles from "./Versions.module.css";

/** Props of {@link VersionsTab}. */
export interface VersionsTabProps {
  /** Whether the operator may change versions. `false` hides validation and activation (read-only view). */
  readonly canEdit: boolean;
}

/** A failure the tab reports. Each has its own fixed message; no server text is shown. */
type TabFailure = "validate" | "download" | ActivationFailureKey;

/**
 * Message key of a failure. A switch rather than a lookup table, so the key is never read from an object by a
 * value that came from outside.
 *
 * @param failure - The failure.
 * @returns The key of its message.
 */
function failureKey(failure: TabFailure): string {
  switch (failure) {
    case "validate":
      return "versions.errors.validate";
    case "download":
      return "versions.errors.download";
    case "conflict":
      return "versions.errors.activateConflict";
    case "generic":
      return "versions.errors.activateFailed";
  }
}

/** Bytes per kilobyte, for the size column. */
const BYTES_PER_KB = 1000;

/**
 * Renders the versions list, the preview of one version, and the actions of each row.
 *
 * @param props - Whether the operator may change versions.
 * @returns The tab, or nothing when the signed-in role is not Admin. The route refuses other roles already; the
 *   check here means the list is never requested for them.
 */
export function VersionsTab({ canEdit }: VersionsTabProps): React.JSX.Element | null {
  const { t, i18n } = useTranslation("site");
  const { api } = useServices();
  const isAdmin = useAuthStore((state) => state.role) === "Admin";
  const editable = canEdit && isAdmin;
  const list = useMapVersions(isAdmin);
  const validate = useValidateMap();
  const activate = useActivateMap();
  const [previewVersion, setPreviewVersion] = useState<MapVersionNumber | null>(null);
  const [confirming, setConfirming] = useState<MapVersionNumber | null>(null);
  const [activated, setActivated] = useState<MapVersionNumber | null>(null);
  const [failure, setFailure] = useState<TabFailure | null>(null);
  // A ref, not state: a second click in the same frame must not mint a second presigned URL.
  const downloading = useRef(false);
  const preview = useSiteMap(previewVersion ?? "active", previewVersion !== null);
  // Derived once per fetched map, not on every render. Before the hooks above, the early return would skip it.
  const previewLayers = useMemo(
    () => (preview.isSuccess ? featureLayers(preview.data) : null),
    [preview.isSuccess, preview.data],
  );
  // The activate button of each version, so that a closed confirmation can return the focus to it.
  const activateButtons = useRef(new Map<MapVersionNumber, HTMLButtonElement>());
  // The version whose confirmation was just closed. Its button takes the focus once it is shown again.
  const focusReturn = useRef<MapVersionNumber | null>(null);
  useEffect(() => {
    if (confirming !== null || focusReturn.current === null) {
      return;
    }
    activateButtons.current.get(focusReturn.current)?.focus();
    focusReturn.current = null;
  }, [confirming]);

  if (!isAdmin) {
    return null;
  }

  const busy = validate.isPending || activate.isPending;
  const versions: readonly MapVersion[] = [...(list.data?.versions ?? [])].sort(
    (left, right) => right.version - left.version,
  );

  /**
   * Validates a pending version.
   *
   * @param version - The version to validate.
   */
  const onValidate = (version: MapVersionNumber): void => {
    setFailure(null);
    validate.mutate(version, {
      onError: () => {
        setFailure("validate");
      },
    });
  };

  /**
   * Closes the confirmation of a version and returns the focus to its activate button.
   *
   * @param version - The version whose confirmation closes.
   */
  const closeConfirm = (version: MapVersionNumber): void => {
    focusReturn.current = version;
    setConfirming(null);
  };

  /**
   * Activates a version after the second press.
   *
   * @param version - The version to activate.
   */
  const onActivate = (version: MapVersionNumber): void => {
    setFailure(null);
    activate.mutate(version, {
      onSuccess: () => {
        closeConfirm(version);
        setActivated(version);
      },
      onError: (error: unknown) => {
        closeConfirm(version);
        setFailure(activationFailureKey(error));
      },
    });
  };

  /**
   * Downloads a valid version. The presigned URL is asked for on the click and handed to the browser at once; it is
   * not kept in the page or logged.
   *
   * @param version - The version to download.
   */
  const onDownload = async (version: MapVersionNumber): Promise<void> => {
    if (downloading.current) return;
    downloading.current = true;
    setFailure(null);
    try {
      const { url } = await fetchMapUrl(api, version);
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.download = `site-map-v${String(version)}.geojson`;
      link.click();
    } catch {
      setFailure("download");
    } finally {
      downloading.current = false;
    }
  };

  /**
   * Formats a creation time in the language of the console.
   *
   * @param iso - The timestamp from the API.
   * @returns The localised date and time.
   */
  const formatDate = (iso: string): string =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );

  return (
    <div>
      {list.isPending ? (
        <p role="status" className={editorStyles.hint}>
          {t("versions.loading")}
        </p>
      ) : null}
      {list.isError ? (
        <p role="alert" className={editorStyles.error}>
          {t("versions.errors.load")}
        </p>
      ) : null}
      {list.isSuccess && versions.length === 0 ? (
        <p className={editorStyles.hint}>{t("versions.empty")}</p>
      ) : null}

      {versions.length > 0 ? (
        <div className={styles.scroll}>
          <table className={editorStyles.table} aria-label={t("versions.title")} aria-busy={busy}>
            <thead>
              <tr>
                <th scope="col">{t("versions.col.version")}</th>
                <th scope="col">{t("versions.col.status")}</th>
                <th scope="col">{t("versions.col.created")}</th>
                <th scope="col">{t("versions.col.createdBy")}</th>
                <th scope="col">{t("versions.col.size")}</th>
                <th scope="col">{t("versions.col.counts")}</th>
                <th scope="col">{t("versions.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => {
                const number = version.version;
                const isValid = version.status === "VALID";
                const canActivate = editable && isValid && !version.active;
                return (
                  <tr key={number}>
                    <td>{t("versions.number", { version: number })}</td>
                    <td>
                      <span className={styles.status}>
                        {isValid ? (
                          <ShieldCheck
                            aria-hidden="true"
                            focusable="false"
                            className={styles.icon}
                          />
                        ) : (
                          <Clock aria-hidden="true" focusable="false" className={styles.icon} />
                        )}
                        {t(`versions.status.${version.status}`)}
                      </span>
                      {version.active ? (
                        <span className={classNames(styles.status, styles.active)}>
                          <CircleCheck
                            aria-hidden="true"
                            focusable="false"
                            className={styles.icon}
                          />
                          {t("versions.active")}
                        </span>
                      ) : null}
                    </td>
                    <td>{formatDate(version.createdAt)}</td>
                    <td>{version.createdBy}</td>
                    <td>
                      {version.sizeBytes === null
                        ? t("versions.none")
                        : t("pick.size", { kb: Math.round(version.sizeBytes / BYTES_PER_KB) })}
                    </td>
                    <td>
                      {version.summary === null
                        ? t("versions.none")
                        : t("versions.counts", {
                            walls: version.summary.counts.wall,
                            workstations: version.summary.counts.workstation,
                            nogo: version.summary.counts.nogo,
                          })}
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={editorStyles.button}
                          aria-pressed={previewVersion === number}
                          onClick={() => {
                            setPreviewVersion(previewVersion === number ? null : number);
                          }}
                        >
                          <Eye aria-hidden="true" focusable="false" className={styles.icon} />
                          {t("versions.view", { version: number })}
                        </button>
                        {isValid ? (
                          <button
                            type="button"
                            className={editorStyles.button}
                            disabled={busy}
                            onClick={() => {
                              void onDownload(number);
                            }}
                          >
                            <Download
                              aria-hidden="true"
                              focusable="false"
                              className={styles.icon}
                            />
                            {t("versions.download", { version: number })}
                          </button>
                        ) : null}
                        {editable && !isValid ? (
                          <button
                            type="button"
                            className={editorStyles.button}
                            disabled={busy}
                            onClick={() => {
                              onValidate(number);
                            }}
                          >
                            {validate.isPending && validate.variables === number
                              ? t("versions.validating")
                              : t("versions.validate", { version: number })}
                          </button>
                        ) : null}
                        {canActivate && confirming !== number ? (
                          <button
                            ref={(element) => {
                              if (element === null) {
                                activateButtons.current.delete(number);
                              } else {
                                activateButtons.current.set(number, element);
                              }
                            }}
                            type="button"
                            className={editorStyles.button}
                            disabled={busy}
                            onClick={() => {
                              setConfirming(number);
                            }}
                          >
                            {t("versions.activate", { version: number })}
                          </button>
                        ) : null}
                        {canActivate && confirming === number ? (
                          <ConfirmActivate
                            version={number}
                            busy={busy}
                            onConfirm={() => {
                              onActivate(number);
                            }}
                            onCancel={() => {
                              closeConfirm(number);
                            }}
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {activated !== null && failure === null ? (
        <p role="status" className={editorStyles.hint}>
          {t("versions.activated", { version: activated })}
        </p>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className={editorStyles.error}>
          {t(failureKey(failure))}
        </p>
      )}

      {previewVersion !== null ? (
        <figure className={editorStyles.canvas}>
          {preview.isPending ? (
            <p role="status" className={editorStyles.hint}>
              {t("versions.loadingPreview")}
            </p>
          ) : null}
          {preview.isError ? (
            <p role="alert" className={editorStyles.error}>
              {t("versions.errors.load")}
            </p>
          ) : null}
          {previewLayers === null ? null : (
            <SiteMapView
              layers={previewLayers}
              label={t("versions.preview", { version: previewVersion })}
            />
          )}
          <figcaption className={editorStyles.legendRow}>
            <MapLegend />
          </figcaption>
        </figure>
      ) : null}
    </div>
  );
}

/** Props of {@link ConfirmActivate}. */
interface ConfirmActivateProps {
  /** The version about to be activated. */
  readonly version: MapVersionNumber;
  /** Whether a request is running. */
  readonly busy: boolean;
  /** Activates the version. */
  readonly onConfirm: () => void;
  /** Keeps the current active version. */
  readonly onCancel: () => void;
}

/**
 * The second press of an activation. It takes the focus when it appears, and Escape cancels it, so the keyboard
 * can finish or drop the change without the pointer.
 *
 * @param props - The version and the handlers.
 * @returns The confirm and cancel buttons.
 */
function ConfirmActivate({
  version,
  busy,
  onConfirm,
  onCancel,
}: ConfirmActivateProps): React.JSX.Element {
  const { t } = useTranslation("site");
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <>
      <button
        ref={confirmRef}
        type="button"
        className={editorStyles.primaryButton}
        disabled={busy}
        aria-busy={busy}
        onClick={onConfirm}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        {t("versions.confirmActivate", { version })}
      </button>
      <button type="button" className={editorStyles.button} disabled={busy} onClick={onCancel}>
        {t("versions.cancelActivate")}
      </button>
    </>
  );
}
