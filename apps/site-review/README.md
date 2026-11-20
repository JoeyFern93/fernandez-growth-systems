# FGS Site Review

Create an account-free review at https://sitereview.fernandezgrowthsystems.com/. Enter a website address and an optional round title. Copy the reviewer link for clients. Keep the private owner link to manage the round from another browser.

Guests can open the live site, leave page notes, and upload or annotate screenshots. A screenshot stays with its original pin when the design changes. The owner can add pages, resolve notes, close the round, or replace its invitation. Everyone holding the current reviewer link can see its screenshots and notes.

## Live element feedback

On a preview you control, include this tag on each page:

```html
<script defer src="https://sitereview.fernandezgrowthsystems.com/live.js"></script>
```

The preview must allow the review service to frame it and load the script. Keep this configuration on the intended preview. Open the preview URL as a review, choose live review, and select an element. Review credentials stay on the review service. See `public/demo/fgs/` for a working preview of the FGS site.

## Deployment

The Cloudflare Pages project builds from `apps/site-review` with `node build-pages.mjs`, output directory `dist`. Apply `schema.sql` to the D1 database declared in `wrangler.jsonc` before serving the API. Run `node --test tests/api.test.mjs` with Node and Python available for SQLite integration checks.

The optional private `fgs-site-review-capture` Worker uses the native Browser Run binding. Pages calls it via `FGS_CAPTURE`. The capture service limits eligible hosts, and the application limits daily use. Image uploads and ordinary page notes work independently of Browser Run. Desktop tab capture requires support from the browser and explicit tab selection by the reviewer.
