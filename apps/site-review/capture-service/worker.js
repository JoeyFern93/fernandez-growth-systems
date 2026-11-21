import { WorkerEntrypoint } from "cloudflare:workers";
import captureWorker, { renderViaCallback } from "../capture.js";

export default class SiteReviewCapture extends WorkerEntrypoint {
  fetch(request) {
    return captureWorker.fetch(request, this.env);
  }

  async renderPublic(pageUrl, device, read) {
    try {
      return await renderViaCallback(this.env.BROWSER, pageUrl, device, read);
    } finally {
      read?.[Symbol.dispose]?.();
    }
  }
}
