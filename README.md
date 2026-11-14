# Fernandez Growth Systems

Static website and Replay Cam for Fernandez Growth Systems.

## Cloudflare Pages

- Framework preset: None
- Build command: `exit 0`
- Build output directory: `site`
- Root directory: repository root

The `site` directory contains the complete website. No package installation or server runtime is required. Replay Cam runs in the visitor's browser and requests camera access only after the visitor starts it.

The production branch is `cloudflare-migration-20261111`; pushes to that branch deploy automatically through the existing Cloudflare Pages project. Other branches can be used for preview verification. Keep the older `main` branch intact unless a separate workflow change is approved.

The live inquiry form uses the existing Web3Forms integration and hCaptcha. Preserve its configuration and privacy information. Provider preview URLs should not be indexed by search engines.

Brand assets are in `site/assets/brand`. The supplied `website/fgs-brand.css` defines the Nunito font and shared tokens; `website/site-brand.css` maps them to the existing website components. Replay Cam uses `replay-brand.css`. Room Measure embeds its font, license, and outlined icon to preserve self-contained HTML downloads. Keep `fonts/OFL-Nunito.txt` with the self-hosted fonts. Placement SVGs contain outlined lettering; do not replace them with website text.

Keep account credentials, DNS worksheets, mail configuration and operational evidence outside this public repository.

Brand v2.0 uses a newly drawn JF leaf contour and naturally proportioned Nunito letterforms. Placement SVGs have no bitmap content or horizontal letter distortion. Transparent PNGs were exported directly by Inkscape and checked for an empty background. The primary SVG canvas is 1644 by 560.
