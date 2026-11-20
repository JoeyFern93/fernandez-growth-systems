# FGS Site Review

Visit https://sitereview.fernandezgrowthsystems.com/, enter a website address, and open it. The reviewer link opens the website with a feedback button in the corner. Use Share to invite a client. Keep the private owner link to manage the round from another browser.

On a connected website, browse to the issue, choose Leave feedback, select the item, and save a note. The real Fernandez Growth Systems website is connected. On other sites that allow embedding, guests can browse and leave a page note. If a website blocks the preview, reviewers can open the original site, use a floating note window in supported desktop browsers, or annotate a screenshot. Everyone holding the current reviewer link can see the round's screenshots and feedback.

## Live element feedback

On a preview you control, include this tag on each page:

```html
<script defer src="https://sitereview.fernandezgrowthsystems.com/live.js"></script>
```

The preview must allow the review service to frame it and load the script. For a site with a same-origin script policy, host `public/live.js` on that site and set the script tag's `data-review-origin` attribute to `https://sitereview.fernandezgrowthsystems.com`. The bridge waits for the trusted review window. Direct visits use the normal website, and review credentials stay on the review service.

## Deployment

The Cloudflare Pages project builds from `apps/site-review` with `node build-pages.mjs`, output directory `dist`. Apply `schema.sql` to the D1 database declared in `wrangler.jsonc` before serving the API. Run `node --test tests/api.test.mjs` with Node and Python available for SQLite integration checks.

The optional private `fgs-site-review-capture` Worker uses the native Browser Run binding. Pages calls it via `FGS_CAPTURE`. The capture service limits eligible hosts, and the application limits daily use. Image uploads and ordinary page notes work independently of Browser Run. Desktop tab capture requires support from the browser and explicit tab selection by the reviewer.
