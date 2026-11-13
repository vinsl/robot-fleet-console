# Screenshots

Stored here, referenced by the README and the report.

## Rules

- Name: `NN-short-description.png` (NN = number from the list below), lowercase, hyphens.
- PNG, 1600 px wide max, compressed (`pngquant` or `oxipng`), < 1 MB (pre-commit blocks > 1.5 MB).
- Dark theme, browser zoom 100 %, no bookmarks bar, no personal tabs.
- Blur or crop before committing: AWS account ids, e-mail addresses, tokens, ARNs with account ids,
  IP addresses of your home network.
- Phone screenshots: status bar visible (the mobile-network icon proves the remote access), console address blurred.

## List

| NN  | What to capture                                        | Milestone |
| --- | ------------------------------------------------------ | --------- |
| 01  | PR checks page, all checks green                       | M1        |
| 02  | Throwaway PR blocked by Gitleaks and lint              | M1        |
| 03  | Terraform plan comment on a PR                         | M2        |
| 04  | Deploy workflow run green                              | M2        |
| 05  | First live video with latency figure                   | M3        |
| 06  | AWS IoT console: robot thing connected                 | M4        |
| 07  | Agent JSON logs with telemetry and ACKs                | M4        |
| 09  | Sign-in with MFA prompt                                | M6        |
| 10  | Security headers check                                 | M6        |
| 11  | DXF layer mapping screen                               | M7        |
| 12  | Resulting site map with charger, stations, no-go zones | M7        |
| 13  | Fleet view with 10 robots                              | M8        |
| 14  | Open Major alert                                       | M8        |
| 15  | Robot page: video + overlay                            | M9        |
| 16  | Command ACK with latency                               | M9        |
| 17  | Lock held by another operator                          | M9        |
| 18  | Audit log                                              | M9        |
| 20  | ZAP baseline summary                                   | M10       |
| 21  | Security Hub CIS score                                 | M10       |
| 23  | Deadman: robot paused after closing the tab            | M10       |
| 24  | Phone on a mobile network: fleet view                  | M11       |
| 25  | KPI sheet after fifteen minutes of fleet               | M11       |
