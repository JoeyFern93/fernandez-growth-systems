import {startOriginal,recordings,loadOriginal} from './originals.mjs';
import {cameras} from './cameras.mjs';

const devices=navigator.mediaDevices;
const stopTracks=stream=>stream?.getTracks().forEach(track=>track.stop());
let listed=[],listing=0,asking=false;

function updateChoices(slots) {
  for(const s of slots){
    const select=s.node.querySelector('.webcam'), room=s.room;
    const choice=s.pendingWebcam?.choice || (room?.local ? room.choice : '');
    const options=[new Option(choice?'Disconnect webcam':'Select webcam',''),new Option('Default webcam','default')];
    for(const device of listed) {
      const key='device:'+device.deviceId;
      const option=new Option(device.label,key);
      option.disabled=slots.some(other=>other!==s && other.room?.local &&
        (other.room.deviceId===device.deviceId || other.room.choice===key));
      options.push(option);
    }
    if(choice && !options.some(option=>option.value===choice))options.push(new Option('Current webcam',choice));
    if(!listed.length)options.push(new Option('Find webcams…','discover'));
    select.replaceChildren(...options);
    select.value=choice;
  }
}
async function list(slots) {
  if(!devices?.enumerateDevices)return;
  const job=++listing;
  try{
    const inputs=await devices.enumerateDevices();
    if(job!==listing)return;
    listed=inputs.filter(d=>d.kind==='videoinput' && d.deviceId && d.label);
    updateChoices(slots);
  }catch{/* The default webcam can still be tried directly. */}
}
function cameraError(error){
  if(error.name==='NotAllowedError')return 'Allow camera access for this site, then select the webcam again.';
  if(error.name==='NotFoundError' || error.name==='OverconstrainedError')return 'Webcam not found. Connect a camera and select it again.';
  if(error.name==='NotReadableError')return 'The webcam is busy. Close the other app using it or choose another camera.';
  return error.message || 'The webcam could not start.';
}
async function discover(slots,slot) {
  if(asking)return;
  asking=true;
  const discovery={};slot.discovery=discovery;
  const epoch=slot.epoch;
  let probe;
  try{
    if(!devices?.getUserMedia)throw Error('This browser cannot access a webcam. Use a camera-enabled browser over HTTPS.');
    slot.status.textContent='Allow access to list webcams, then choose one.';
    probe=await devices.getUserMedia({video:true,audio:false});
    if(slot.discovery!==discovery)return;
    discovery.stream=probe;await list(slots);
    if(slot.epoch===epoch)slot.status.textContent=listed.length?'Choose a webcam from the list.':'Choose Default webcam to use this browser’s camera.';
  }catch(error){if(slot.epoch===epoch)slot.status.textContent=cameraError(error);}
  finally{stopTracks(probe);if(slot.discovery===discovery)slot.discovery=null;asking=false;updateChoices(slots);}
}
export function bindWebcams(slots,{begin,dispose,receive}) {
  const render=()=>updateChoices(slots);
  for(const slot of slots) {
    const select=slot.node.querySelector('.webcam');
    select.onchange=async()=>{
      const choice=select.value;
      slot.pendingWebcam=null;
      if(choice==='discover'){render();await discover(slots,slot);return;}
      if(!choice){if(slot.room?.local)dispose(slot,'Webcam disconnected.');render();return;}
      if(!devices?.getUserMedia){slot.status.textContent='This browser cannot access a webcam. Open Replay Cam over HTTPS in a camera-enabled browser.';render();return;}
      if(slots.some(other=>other!==slot && (other.pendingWebcam?.choice===choice || (other.room?.local && other.room.choice===choice)))){
        slot.status.textContent='This webcam is already in the other view. Choose a different camera.';render();return;
      }
      const room={local:true,choice,controller:new AbortController()};
      // Keep the current source until the selected webcam has delivered a usable track.
      slot.pendingWebcam=room;
      render();
      try{
        const video={width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60}};
        if(choice.startsWith('device:'))video.deviceId={exact:choice.slice(7)};
        slot.status.textContent='Opening webcam…';
        const stream=await devices.getUserMedia({audio:false,video});
        if(slot.pendingWebcam!==room){stopTracks(stream);return;}
        room.stream=stream;
        const track=stream.getVideoTracks()[0];
        if(!track)throw Error('No video track was available. Choose another webcam.');
        room.deviceId=track.getSettings?.().deviceId || (choice.startsWith('device:')?choice.slice(7):'');
        room.deviceLabel=track.label;
        if(slots.some(other=>{
          const used=other.room;
          if(other===slot || !used?.local)return false;
          if(room.deviceId && used.deviceId)return room.deviceId===used.deviceId;
          return room.deviceLabel && room.deviceLabel===used.deviceLabel;
        })){
          throw Error('This webcam is already in the other view. Choose a different camera.');
        }
        if(slot.room?.local && room.deviceId && slot.room.deviceId===room.deviceId){
          stopTracks(stream);return;
        }
        begin(slot,room);
        track.addEventListener('ended',()=>{if(slot.room===room){dispose(slot,'Webcam disconnected. Choose a camera to reconnect.');list(slots);}}, {once:true});
        receive(slot,room,track);
        list(slots);
        try{
          room.originalReady=startOriginal(stream,slot.name,message=>{
            room.originalError=String(message);
            if(slot.room===room)slot.status.textContent=room.originalError;
          },'webcam');
          const original=await room.originalReady;
          if(slot.room!==room){await original.stop();return;}
          room.original=original;
        }catch{room.originalError='Original recording unavailable on this device.';}
      }catch(error){
        if(slot.room===room)dispose(slot,cameraError(error));
        else {
          stopTracks(room.stream);
          if(slot.pendingWebcam===room)slot.status.textContent=cameraError(error);
        }
      }finally{
        if(slot.pendingWebcam===room)slot.pendingWebcam=null;
        render();
      }
    };
  }
  list(slots);
  devices?.addEventListener?.('devicechange',()=>list(slots));
  return render;
}

function download(container,blob,label,filename) {
  const old=container.querySelector('a');
  if(old)URL.revokeObjectURL(old.href);
  const link=document.createElement('a');
  link.href=URL.createObjectURL(blob);
  link.download=filename+'.'+(blob.type.includes('mp4')?'mp4':'webm');
  link.textContent=label;container.replaceChildren(link);
}
export function offerClip(slot,blob,clipId) {
  const list=document.getElementById('clip-downloads');
  let item=list.querySelector('[data-camera="'+slot.cameraId+'"]');
  if(!item){item=document.createElement('div');item.dataset.camera=slot.cameraId;list.append(item);}
  download(item,blob,'Download '+slot.label+' clip','FGS-Camera-'+slot.cameraId+'-'+clipId);
}
export function clearClipDownloads(){
  const list=document.getElementById('clip-downloads');
  for(const link of list.querySelectorAll('a'))URL.revokeObjectURL(link.href);
  list.replaceChildren();
}
const details=document.getElementById('local-originals'), originals=document.getElementById('original-list');
details.ontoggle=async()=>{
  if(!details.open)return;
  try{
    const rows=(await recordings()).filter(row=>row.source==='webcam').sort((a,b)=>b.date-a.date);
    for(const link of originals.querySelectorAll('a'))URL.revokeObjectURL(link.href);
    originals.replaceChildren();
    if(!rows.length){originals.textContent='No webcam originals saved on this device.';return;}
    for(const row of rows){
      const camera=cameras.find(c=>c.angle===row.angle),item=document.createElement('div'),button=document.createElement('button');
      const label=(camera?.label || 'Webcam')+' original · '+new Date(row.date).toLocaleString();
      button.textContent='Open '+label;item.append(button);originals.append(item);
      button.onclick=async()=>{
        try{button.disabled=true;download(item,await loadOriginal(row),'Download '+label,'FGS-Camera-'+(camera?.id || 'webcam')+'-'+row.date);}
        catch(error){button.disabled=false;button.textContent=error.message;}
      };
    }
  }catch{originals.textContent='Could not read webcam recordings from this browser.';}
};
