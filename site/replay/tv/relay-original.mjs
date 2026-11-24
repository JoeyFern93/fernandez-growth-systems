import {startOriginal, recordings, loadOriginal} from '../multicam/originals.mjs';
import {cameras} from '../multicam/cameras.mjs';

const panel = document.getElementById('relay-original-panel');
const status = document.getElementById('relay-original-status');
const details = document.getElementById('relay-originals');
const list = document.getElementById('relay-original-list');
const params = new URLSearchParams(location.hash.slice(1));
const angle = cameras.find(camera => camera.id === params.get('camera'));
const relayInvite = params.get('transport') === 'relay' && !!angle;
const source = 'relay-phone';
let active = null, latest = null, revision = 0;
const downloads = new Set();

function revokeDownloads() {
  for (const url of downloads) URL.revokeObjectURL(url);
  downloads.clear();
}

async function listOriginals() {
  const current = ++revision;
  revokeDownloads();
  list.textContent = 'Opening phone originals…';
  try {
    const saved = (await recordings()).filter(row => row.source === source && row.id !== active?.id)
      .sort((a,b) => b.date - a.date);
    if (current !== revision) return;
    list.textContent = saved.length ? '' : 'Finished originals will appear here.';
    for (const row of saved) {
      const label = cameras.find(camera => camera.angle === row.angle)?.label || 'Camera';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label + ' · ' + new Date(row.date).toLocaleString();
      const item = document.createElement('p');
      item.append(button);
      list.append(item);
      button.onclick = async () => {
        button.disabled = true;
        try {
          const blob = await loadOriginal(row);
          if (current !== revision || !item.isConnected) return;
          const url = URL.createObjectURL(blob);
          downloads.add(url);
          const link = document.createElement('a');
          link.href = url;
          link.download = 'FGS-' + label.replace(/ /g,'-') + '-original-' + row.date +
            (blob.type.includes('mp4') ? '.mp4' : '.webm');
          link.textContent = 'Download ' + label + ' original';
          item.replaceChildren(link);
        } catch {
          if (current !== revision) return;
          button.disabled = false;
          status.textContent = 'This recording has no readable saved video yet.';
        }
      };
    }
  } catch {
    if (current === revision) list.textContent = 'Phone storage could not be opened.';
  }
}

async function finish(session) {
  if (!session || session.finishing) return;
  session.finishing = true;
  session.controller.abort();
  try {
    const recorder = await session.ready;
    const saved = recorder && await recorder.stop();
    if (!active && latest === session) status.textContent = saved && !session.failed
      ? 'Original saved on this phone.' : 'Original saving could not be confirmed. Check Phone originals.';
  } catch {
    if (!active && latest === session) status.textContent = 'Original saving could not be confirmed. Check Phone originals.';
  }
  if (details.open) listOriginals();
}

window.addEventListener('fgs:relay-angle-capture', event => {
  const camera = cameras.find(candidate => candidate.id === String(event.detail?.cameraId));
  const stream = event.detail?.stream;
  const track = stream?.getVideoTracks?.()[0];
  if (!camera || !track || track.readyState !== 'live' || active?.track === track) return;
  const previous = active;
  const session = {track, controller:new AbortController(), failed:false};
  latest = active = session;
  panel.hidden = false;
  finish(previous);
  status.textContent = 'Starting the original recording on this phone…';
  // Recording and storage are independent of the phone-to-display connection.
  function failed() {
    session.failed = true;
    if (active === session) status.textContent = 'Phone original unavailable. TV streaming can continue.';
  }
  session.ready = startOriginal(stream, camera.angle, failed, source, session.controller.signal).then(recorder => {
    session.id = recorder.id;
    if (active === session && !session.failed) status.textContent = 'Recording the original on this phone.';
    return recorder;
  }).catch(() => { failed(); return null; });
});

window.addEventListener('fgs:relay-angle-stop', () => {
  const session = active;
  if (!session) return;
  active = null;
  if (!session.failed) status.textContent = 'Finishing the phone original…';
  finish(session);
});
details.addEventListener('toggle', () => {
  if (details.open) listOriginals();
  else { revision++; revokeDownloads(); }
});
window.addEventListener('pagehide', revokeDownloads);

if (relayInvite) {
  panel.hidden = false;
  status.textContent = 'Start camera also records the original on this phone.';
  document.querySelector('.quality-original')?.setAttribute('hidden','');
  try { sessionStorage.setItem('fgs-relay-phone-originals','1'); } catch {}
} else if (!location.hash) {
  try {
    if (sessionStorage.getItem('fgs-relay-phone-originals') === '1') panel.hidden = false;
  } catch {}
}
