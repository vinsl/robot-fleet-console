# Report sources

The two-page French report is `main_fr.tex`. It is typeset with XeTeX and uses TeX Gyre Termes, a metric clone of Times.

## Build

```sh
cd docs/report/overleaf
tectonic -X compile main_fr.tex
```

Tectonic downloads the TeX packages it needs on the first run. In Overleaf, choose the XeLaTeX compiler and upload the
whole folder, including `icons/` and `images/`.

## Layout

- `main_fr.tex`: the report text.
- `style.tex`: page layout, fonts, macros for sections, screenshots, tables and difficulty blocks.
- `figures/architecture.tex` and `figures/safety.tex`: the diagrams, drawn with TikZ and the official AWS architecture icons.
  `figures/architecture-en.tex` is the English variant of the architecture diagram, exported to `docs/architecture.png` for the README.
- `icons/`: the AWS architecture icons used by the diagrams, converted to PDF.
- `images/`: screenshots and the OWASP ZAP summary table (`zap-summary.png`, rendered from the ZAP HTML report).
- `../facts.md` and `../cost-estimate.md`: the source of every number printed in the report.
