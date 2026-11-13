/**
 * QR code of the TOTP enrolment, drawn as SVG on the client. The `qrcode` library only computes the module
 * matrix; the SVG is built from React elements, so no markup string is injected into the page and nothing is
 * fetched from the network.
 */
import type * as React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { create } from "qrcode";
import styles from "./TotpQrCode.module.css";

/** Blank modules around the code, as the QR specification requires for scanners. */
const QUIET_ZONE = 4;

/** Module grid of a code, with its quiet zone, and the path that draws the dark modules. */
interface ModuleDrawing {
  readonly size: number;
  readonly path: string;
}

/**
 * Computes the dark modules of a QR code for a text.
 *
 * @param text - The text to encode, here an `otpauth://` URI.
 * @returns The drawing, or `null` when the library cannot encode the text.
 */
function drawModules(text: string): ModuleDrawing | null {
  try {
    const { modules } = create(text, { errorCorrectionLevel: "M" });
    const side = modules.size;
    let path = "";
    for (let row = 0; row < side; row += 1) {
      for (let column = 0; column < side; column += 1) {
        if (modules.data[row * side + column] === 1) {
          path += `M${String(column + QUIET_ZONE)} ${String(row + QUIET_ZONE)}h1v1h-1z`;
        }
      }
    }
    return { size: side + 2 * QUIET_ZONE, path };
  } catch {
    // The secret is also shown as text, so a failed drawing does not block the enrolment.
    return null;
  }
}

/** Props of {@link TotpQrCode}. */
export interface TotpQrCodeProps {
  /** The `otpauth://totp` URI of the enrolment. */
  readonly uri: string;
}

/**
 * Renders the enrolment QR code. Dark modules are the ink colour on the light text colour, which scanners read
 * reliably.
 *
 * @param props - The URI to encode.
 * @returns The SVG, or nothing when the code cannot be drawn.
 */
export function TotpQrCode({ uri }: TotpQrCodeProps): React.JSX.Element | null {
  const { t } = useTranslation("auth");
  const drawing = useMemo(() => drawModules(uri), [uri]);
  if (drawing === null) {
    return null;
  }
  return (
    <svg
      role="img"
      aria-label={t("totpSetup.qrLabel")}
      viewBox={`0 0 ${String(drawing.size)} ${String(drawing.size)}`}
      className={styles.qr}
      focusable="false"
    >
      <rect className={styles.background} x={0} y={0} width={drawing.size} height={drawing.size} />
      <path className={styles.modules} d={drawing.path} />
    </svg>
  );
}
