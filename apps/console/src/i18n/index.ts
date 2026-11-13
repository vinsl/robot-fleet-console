/**
 * Internationalisation of the console: English and French, with English as the fallback.
 *
 * Resources are bundled, so the first render never waits for a translation download. The chosen language is
 * the only thing kept in `localStorage`, and it is not a credential.
 */
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import enAlerts from "./locales/en/alerts.json";
import enAudit from "./locales/en/audit.json";
import enAuth from "./locales/en/auth.json";
import enDemo from "./locales/en/demo.json";
import enCommon from "./locales/en/common.json";
import enFleet from "./locales/en/fleet.json";
import enKpi from "./locales/en/kpi.json";
import enRobot from "./locales/en/robot.json";
import enShell from "./locales/en/shell.json";
import enSite from "./locales/en/site.json";
import enStates from "./locales/en/states.json";
import frAlerts from "./locales/fr/alerts.json";
import frAudit from "./locales/fr/audit.json";
import frAuth from "./locales/fr/auth.json";
import frDemo from "./locales/fr/demo.json";
import frCommon from "./locales/fr/common.json";
import frFleet from "./locales/fr/fleet.json";
import frKpi from "./locales/fr/kpi.json";
import frRobot from "./locales/fr/robot.json";
import frShell from "./locales/fr/shell.json";
import frSite from "./locales/fr/site.json";
import frStates from "./locales/fr/states.json";

/** Languages the console ships. */
export const SUPPORTED_LANGUAGES = ["en", "fr"] as const;

/** A language the console ships. */
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Key of the language preference in `localStorage`. */
export const LANGUAGE_STORAGE_KEY = "mfc.lang";

/** Bundled resources, by language and namespace. Every namespace must exist in every language (tested). */
export const RESOURCES = {
  en: {
    common: enCommon,
    auth: enAuth,
    shell: enShell,
    site: enSite,
    states: enStates,
    fleet: enFleet,
    alerts: enAlerts,
    kpi: enKpi,
    robot: enRobot,
    audit: enAudit,
    demo: enDemo,
  },
  fr: {
    common: frCommon,
    auth: frAuth,
    shell: frShell,
    site: frSite,
    states: frStates,
    fleet: frFleet,
    alerts: frAlerts,
    kpi: frKpi,
    robot: frRobot,
    audit: frAudit,
    demo: frDemo,
  },
} as const;

/**
 * Tells whether a value is a language the console ships.
 *
 * @param value - Any value, for example one read from storage.
 * @returns `true` when the value is one of {@link SUPPORTED_LANGUAGES}.
 */
function isLanguage(value: unknown): value is Language {
  return SUPPORTED_LANGUAGES.some((language) => language === value);
}

/**
 * Reads the stored language preference. Storage can be disabled, so a failure means "no preference".
 *
 * @returns The stored language, or `null`.
 */
function readStoredLanguage(): Language | null {
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Persists the language preference. Failure is ignored: the choice then lasts for the page only.
 *
 * @param language - The language to remember.
 */
function writeStoredLanguage(language: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage unavailable: the language still applies for this page.
  }
}

// The document language follows the UI, so that screen readers pick the right pronunciation.
// The guard keeps the module importable where there is no document (unit tests).
i18next.on("languageChanged", (language: string) => {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
  if (isLanguage(language)) {
    writeStoredLanguage(language);
  }
});

void i18next.use(initReactI18next).init({
  resources: RESOURCES,
  lng: readStoredLanguage() ?? "en",
  fallbackLng: "en",
  supportedLngs: [...SUPPORTED_LANGUAGES],
  ns: [
    "common",
    "auth",
    "shell",
    "site",
    "states",
    "fleet",
    "alerts",
    "kpi",
    "robot",
    "audit",
    "demo",
  ],
  defaultNS: "common",
  // React escapes every interpolated value; a second escape would show "&amp;" to the user.
  interpolation: { escapeValue: false },
  // Resources are bundled, so initialisation is synchronous and the first render is already translated.
  initAsync: false,
});

/**
 * Switches the UI language. The choice is remembered for the next visit.
 *
 * @param language - The language to show.
 */
export async function setLanguage(language: Language): Promise<void> {
  await i18next.changeLanguage(language);
}
