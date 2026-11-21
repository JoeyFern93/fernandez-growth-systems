# FGS Site Review

Visit https://sitereview.fernandezgrowthsystems.com/, enter a website address, and open it. The reviewer link opens the site or its saved screenshot with a feedback button in the corner. Use **Share** to invite a client. Feedback is saved to the review on FGS Site Review. Anyone holding the current reviewer link can open **Notes** to read it. Keep the private owner link to manage the round from another browser.

On a connected website, browse to the issue, choose Leave feedback, select the item, and save a note. The real Fernandez Growth Systems website is connected. On other sites that allow embedding, guests can browse and leave a page note. If a website blocks the preview, reviewers can open the original site, use a floating note window in supported desktop browsers, or annotate a screenshot. Everyone holding the current reviewer link can see the round's screenshots and feedback.

## Live element feedback

On a preview you control, include this tag on each page:

```html
<script defer src="https://sitereview.fernandezgrowthsystems.com/live.js"></script>
```

The preview must allow the review service to frame it and load the script. For a site with a same-origin script policy, host `public/live.js` on that site and set the script tag's `data-review-origin` attribute to `https://sitereview.fernandezgrowthsystems.com`. The bridge waits for the trusted review window. Direct visits use the normal website, and review credentials stay on the review service.

## Desktop Chrome extension

Setup and the downloadable extension are at https://sitereview.fernandezgrowthsystems.com/chrome/. For local development, open Chrome's extensions page, enable Developer mode, select **Load unpacked**, and choose the `extension` directory that contains `manifest.json`.

On the website you want to review, open the extension and choose **Leave feedback**. Choose **Element** to select an item, **Point** to pin a spot, **Draw** to mark an area, or **Page** for a general comment. Write the note and choose **Send feedback**. Choose **View notes** to see it. To find it later, open **My reviews** in the extension and choose **Open notes** for that site. This list is local to the current Chrome profile. The notes themselves are stored in the shared review on the server.

Choose **Copy client link** to invite someone to review the site. To share what you see, select **Visible area** or **Full page**, choose **Capture a screenshot**, check the preview and choose **Share & copy link**. A client can open that image on their phone, scroll to a section, pin a spot or draw on it, and submit a note without an account. In **Notes**, choose **Show mark on screenshot** to return to the same spot. On an existing review link, choose **Use this review** in the extension to attach live-site feedback to the same project.

## Deployment

The Cloudflare Pages project builds from `apps/site-review` with `node build-pages.mjs`, output directory `dist`. Apply `schema.sql` to the D1 database declared in `wrangler.jsonc` before serving the API. Run `node --test tests/api.test.mjs tests/fullpage-storage.test.mjs` with Node and Python available for SQLite integration checks.

The private `fgs-site-review-capture` Worker runs the remote browser. Deploy `capture-service/worker.js` with `capture-service/wrangler.jsonc` and its `BROWSER` binding. For the Cloudflare dashboard editor, `node capture-service/dashboard-build.mjs` writes the equivalent single-file module and prints its path. Deploy this service before the Pages application, which calls it through the `FGS_CAPTURE` binding. Keep `global_fetch_strictly_public` in the Pages compatibility flags. The capture Worker needs no public route or API credential.

For configured websites and supported hosted previews, Cloudflare Browser Run can take the full-page image directly. Other eligible public HTTPS pages open in a fresh browser session with direct network access blocked. The session requests public documents and assets through a private callback to Pages. Pages checks public DNS, validates each destination and issues credential-free GET requests with manual redirects. A separate HEAD request can identify sites that block embedding. The capture service closes each browser session when it finishes.

The review stores the screenshot against its selected page at the dimensions returned by the renderer. Full-page images support up to 10 MiB, 60,000 pixels in height and 60 million pixels in area. Capture reservations limit cloud browser use across the service. A login, bot challenge, query-string URL, exceptionally large page or unavailable remote browser can prevent an automatic capture. Reviewers can open the original site, capture the tab with the Chrome extension, or upload an image. Run `node --test tests/fullpage-capture.test.mjs` for the capture checks. Set `FGS_CHROME_BIN` if local Chromium is outside the standard Chrome installation paths.
