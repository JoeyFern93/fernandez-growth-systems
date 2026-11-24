// MediaRecorder can batch, drop, or reorder pictures. Keep the sample clock on
// its own picture through the codec, then remove the strip before displaying
// or saving it. Two rows of monochrome cells survive chroma subsampling.
const bytesPerStamp = 13;
const columns = bytesPerStamp * 4;
const footerHeight = width => Math.max(12, 2 * Math.round(width / 112));
const fallbackUncertainty = 70;

function checksum(bytes) {
  let crc = 0xffff;
  for (const byte of bytes.subarray(0, 11)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

function encode(stamp, estimated) {
  const data = new Uint8Array(bytesPerStamp);
  data.set([0xe9, 0x5a, estimated ? 2 : 1]);
  let time = Math.round(stamp?.time);
  const uncertainty = Math.ceil(stamp?.uncertainty + (estimated ? fallbackUncertainty : 1));
  if (Number.isSafeInteger(time) && time > 0 && time < 2**48 && uncertainty >= 0 && uncertainty < 65535) {
    for (let i=8; i>=3; i--) { data[i] = time % 256; time = Math.floor(time / 256); }
    data[9] = uncertainty >>> 8; data[10] = uncertainty & 255;
  }
  const crc=checksum(data); data[11]=crc>>>8; data[12]=crc & 255;
  return data;
}

export function createStampWriter(clock) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', {alpha:false});
  const cells = document.createElement('canvas');
  cells.width = columns; cells.height = 2;
  const bits = cells.getContext('2d', {alpha:false});
  const pixels = bits.createImageData(columns,2);
  let stream;
  return {
    paint(source, sample) {
      const width=source.width, height=source.height, rows=footerHeight(width);
      if (canvas.width!==width || canvas.height!==height+rows) {
        canvas.width=width; canvas.height=height+rows;
        stream?.getVideoTracks()[0]?.dispatchEvent(new CustomEvent('fgs-resize',{detail:{width,height:height+rows}}));
      }
      const stamp = sample && clock?.toServer(sample.time);
      const bytes = encode(stamp, sample?.estimated === true);
      for (let i=0;i<bytesPerStamp*8;i++) {
        const value = bytes[i>>3] & (128 >> (i&7)) ? 247 : 8;
        const at=i*4;
        pixels.data[at]=pixels.data[at+1]=pixels.data[at+2]=value; pixels.data[at+3]=255;
      }
      bits.putImageData(pixels,0,0);
      context.drawImage(source,0,0);
      context.imageSmoothingEnabled=false;
      context.drawImage(cells,0,height,width,rows);
    },
    getStream() { return stream ||= canvas.captureStream(); },
    ownsStream(candidate) { return Boolean(stream && stream===candidate); },
    stop() { stream?.getTracks().forEach(track=>track.stop()); stream=null; }
  };
}

export function createStampReader() {
  const sample=document.createElement('canvas'); sample.width=columns;sample.height=2;
  const ctx=sample.getContext('2d',{willReadFrequently:true});
  ctx.imageSmoothingEnabled=false;
  let marked=false;
  return function inspect(source,width,height) {
    const rows=footerHeight(width);
    if(width < columns*2 || height<=rows)return {height,stamp:null};
    ctx.drawImage(source,0,height-rows,width,rows,0,0,columns,2);
    const pixels=ctx.getImageData(0,0,columns,2).data;
    const bytes=new Uint8Array(bytesPerStamp);
    for(let i=0;i<bytesPerStamp*8;i++) {
      if(pixels[i*4]>127)bytes[i>>3]|=128 >> (i&7);
    }
    const valid=bytes[0]===0xe9 && bytes[1]===0x5a && (bytes[2]===1 || bytes[2]===2) &&
      checksum(bytes)===(bytes[11]*256+bytes[12]);
    if(!valid)return {height:marked?height-rows:height,stamp:null};
    marked=true;
    let time=0;
    for(let i=3;i<=8;i++)time=time*256+bytes[i];
    const uncertainty=bytes[9]*256+bytes[10];
    return {height:height-rows,stamp:time>0?{time,uncertainty,estimated:bytes[2]===2}:null};
  };
}
