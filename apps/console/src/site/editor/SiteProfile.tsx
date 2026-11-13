/**
 * Header of the editor: the site name, which the operator can rename, and the map the site uses now.
 *
 * The name is checked with the protocol grammar before the request, and the server checks it again. The name
 * field keeps what the operator typed until the save succeeds, so a refused save loses nothing.
 */
import type * as React from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { SITE_NAME_MAX, SiteNameSchema } from "@mfc/protocol";
import { useSite, useUpdateSite } from "../../api/site";
import styles from "./Editor.module.css";

/**
 * Renders the site name form and the active map of the site.
 *
 * @returns The header.
 */
export function SiteProfile(): React.JSX.Element {
  const { t } = useTranslation("site");
  const site = useSite();
  const update = useUpdateSite();
  const inputId = useId();
  const hintId = useId();
  // `null` means the field shows the stored name; once typed, the field keeps the operator's text.
  const [typed, setTyped] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);

  if (site.isPending) {
    return (
      <p role="status" className={styles.hint}>
        {t("profile.loading")}
      </p>
    );
  }
  if (site.isError) {
    return (
      <p role="alert" className={styles.error}>
        {t("profile.loadFailed")}
      </p>
    );
  }

  const value = typed ?? site.data.name;

  const onSubmit = (event: React.SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = SiteNameSchema.safeParse(value);
    setSaved(false);
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    update.mutate(
      { name: parsed.data },
      {
        onSuccess: () => {
          setTyped(null);
          setSaved(true);
        },
      },
    );
  };

  let hint: string;
  if (invalid) {
    hint = t("profile.invalidName", { max: SITE_NAME_MAX });
  } else if (site.data.activeVersion === null) {
    hint = t("profile.noActive");
  } else {
    hint = t("profile.active", { version: site.data.activeVersion });
  }

  return (
    <section className={styles.step}>
      <form className={styles.actions} onSubmit={onSubmit} noValidate>
        <label htmlFor={inputId} className={styles.hint}>
          {t("profile.name")}
        </label>
        <input
          id={inputId}
          type="text"
          className={styles.input}
          value={value}
          maxLength={SITE_NAME_MAX}
          aria-invalid={invalid}
          aria-describedby={hintId}
          onChange={(event) => {
            setTyped(event.target.value);
            setInvalid(false);
          }}
        />
        <button
          type="submit"
          className={styles.button}
          disabled={update.isPending}
          aria-busy={update.isPending}
        >
          {update.isPending ? t("profile.saving") : t("profile.save")}
        </button>
      </form>
      <p id={hintId} className={invalid ? styles.error : styles.hint}>
        {hint}
      </p>
      {saved ? (
        <p role="status" className={styles.hint}>
          {t("profile.saved")}
        </p>
      ) : null}
      {update.isError ? (
        <p role="alert" className={styles.error}>
          {t("profile.saveFailed")}
        </p>
      ) : null}
    </section>
  );
}
