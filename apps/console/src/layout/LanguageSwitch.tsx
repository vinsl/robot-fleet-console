/**
 * Language switch of the status line. Two toggle buttons; the pressed one is the current language, so the
 * state is carried by text and `aria-pressed`, not by colour.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, setLanguage } from "../i18n";
import styles from "./LanguageSwitch.module.css";

/**
 * Renders one toggle per supported language. The choice is persisted by the i18n module.
 *
 * @returns The switch.
 */
export function LanguageSwitch(): React.JSX.Element {
  const { t, i18n } = useTranslation("shell");
  const current = i18n.resolvedLanguage ?? "en";
  return (
    <div role="group" aria-label={t("language.label")} className={styles.group}>
      {SUPPORTED_LANGUAGES.map((language) => {
        const pressed = current === language;
        return (
          <button
            key={language}
            type="button"
            aria-pressed={pressed}
            lang={language}
            className={pressed ? styles.active : styles.option}
            onClick={() => {
              void setLanguage(language);
            }}
          >
            {t(`language.short.${language}`)}
          </button>
        );
      })}
    </div>
  );
}
