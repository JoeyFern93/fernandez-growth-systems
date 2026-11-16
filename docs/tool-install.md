# Add a tool to the home screen

The shared install UI is used by Replay Cam, Room Measure, and the tools directory.
It always provides an **Add as app** button and a dismissible suggestion. A real
`beforeinstallprompt` event enables the browser's native prompt, invoked only by
a user click. Other browsers receive device-specific instructions. An installed
app window shows **App options** instead; this does not infer whether another
tool from the same site was separately installed.

## Reuse for a new, working tool

1. Add `/assets/tool-install-v1.css` and deferred
   `/assets/tool-install-v1.js` to the page. Add a visible button:

   ```html
   <button type="button" data-tool-install data-tool-install-ui>Add as app</button>
   ```

2. Give that tool its own manifest with stable, distinct `id`, `start_url`, and
   `scope`, a `name`, `short_name`, `display: standalone`, and the approved
   192px/512px PNG icons. Link it from that tool's HTML. Do not reuse Replay's
   manifest for a different tool. Preserve existing IDs during later updates.
3. Add the exact route aliases and tool configuration to the `apps` map in the
   shared script. Only set `worker` and `scope` if a matching dedicated service
   worker exists; a page with its own worker, like Replay, registers it itself.
4. A worker must accept only same-origin GETs, explicitly list its app shell,
   and restrict navigation fallback to its own tool routes. Never map every
   navigation in a broad scope to one tool's homepage. Delete only that tool's
   old cache prefix. Do not cache camera/media, imported files, projects, inquiry
   pages or external APIs. Set the worker response to `Cache-Control: no-cache`.
5. Permit same-origin manifests, worker scripts, script and CSS files in the
   page's CSP. Do not broaden unrelated network or permissions policies.
6. For self-contained HTML exports, remove nodes marked
   `data-tool-install-ui`, `data-tool-install-resource`, and
   `data-tool-install-script` from the exported clone. Room Measure does this
   without touching its project payload or measurement logic.

When changing the shared install assets later, version their filenames and update
each tool's worker shell and cache version together. Keep manifest app identities
stable even when the manifest filename itself changes.

## Current identities

| Tool | ID and start URL | Manifest scope | Worker scope |
| --- | --- | --- | --- |
| Tools directory | `/tools` | `/tools` | `/tools` |
| Room Measure | `/tools/room-measure` | `/tools/room-measure` | `/tools/room-measure` |
| Replay Cam | `/replay/` | `/replay/` | `/replay/` |

The directory's scope contains Room Measure, but its worker deliberately ignores
Room Measure navigations. The Room worker has the more specific scope and caches
only Room Measure. Opening another tool from the directory may use a browser
window if that route is outside the installed directory app's scope.

Test a native browser install where supported, manual iPhone/iPad instructions,
keyboard dialog open/Escape/focus return, banner dismissal, each app's launch
route, and an offline reload after its worker activates. Native installation
cannot be inferred from the existence of the button or manifest. `userChoice`
acceptance alone is not displayed as completed installation; `appinstalled` is
the confirming event for the current visit.

References checked November 16, 2026:
- https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
- https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event
- https://web.dev/learn/pwa/installation
