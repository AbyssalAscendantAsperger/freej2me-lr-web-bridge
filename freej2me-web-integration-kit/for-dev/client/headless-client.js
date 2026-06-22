(function(global){
class FreeJ2MEHeadlessClient{
  constructor({baseUrl='', token='', canvas, onStatus=()=>{}, onConfig=()=>{}}){
    this.baseUrl=baseUrl.replace(/\/$/,''); this.token=token;
    this.canvas=typeof canvas==='string'?document.querySelector(canvas):canvas;
    this.ctx=this.canvas.getContext('2d',{alpha:false}); this.onStatus=onStatus; this.onConfig=onConfig;
    this.ws=null; this.config={width:240,height:320,videoCodec:'rgba',imageQuality:100}; this.imageData=null; this.latest=null; this.raf=false;
    this.audioCtx=null; this.audioUnlocked=false; this.audioNext=0; this.audioFormat={sampleRate:48000,channels:2,bits:16,signed:true,bigEndian:false};
  }
  async createInstance({file, externalUserId, width=240, height=320, options={}}){
    const fd=new FormData(); fd.append('jar',file); fd.append('externalUserId',externalUserId); fd.append('width',width); fd.append('height',height);
    Object.entries(options).forEach(([k,v])=>fd.append(k,v));
    const r=await fetch(this.baseUrl+'/api/instances',{method:'POST',headers:this.token?{'X-Bridge-Token':this.token}:{},body:fd});
    const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||r.statusText); return j;
  }
  connect(instanceId){
    const proto=this.baseUrl.startsWith('https')?'wss':(location.protocol==='https:'?'wss':'ws');
    let host=location.host; if(this.baseUrl.startsWith('http')) host=new URL(this.baseUrl).host;
    const qs=this.token?'?token='+encodeURIComponent(this.token):'';
    this.ws=new WebSocket(proto+'://'+host+'/ws/'+encodeURIComponent(instanceId)+qs); this.ws.binaryType='arraybuffer';
    this.ws.onopen=()=>this.onStatus('connected'); this.ws.onclose=()=>this.onStatus('closed'); this.ws.onerror=()=>this.onStatus('error');
    this.ws.onmessage=e=>{ if(e.data instanceof ArrayBuffer){const u8=new Uint8Array(e.data); if(!this.handleAudio(u8)){this.latest=u8; this.drawLater();}} else {const m=JSON.parse(e.data); if(m.type==='config'){this.config=m; this.canvas.width=m.width; this.canvas.height=m.height; this.onConfig(m);} }};
  }
  send(o){ if(this.ws&&this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(o)); }
  key(key,state){this.send({type:'key',key,state});} touch(state,x,y){this.send({type:'touch',state,x,y});}
  unlockAudio(){ if(!this.audioCtx)this.audioCtx=new (window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'}); this.audioCtx.resume(); this.audioUnlocked=true; this.audioNext=this.audioCtx.currentTime+0.08; }
  handleAudio(u8){ if(!(u8&&u8.length>=5&&u8[0]===0x46&&u8[1]===0x4A&&u8[2]===0x32&&u8[3]===0x41))return false; const type=u8[4],dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength); if(type===1&&u8.length>=13){this.audioFormat={sampleRate:dv.getUint32(5,false),channels:u8[9]||1,bits:u8[10]||16,signed:u8[11]!==0,bigEndian:u8[12]!==0}; return true;} if(type!==2||!this.audioUnlocked||!this.audioCtx||this.audioFormat.bits!==16)return true; const len=dv.getUint32(5,false); if(len<=0||9+len>u8.length)return true; const chs=this.audioFormat.channels,frames=Math.floor(len/(2*chs)); if(frames<=0)return true; const b=this.audioCtx.createBuffer(chs,frames,this.audioFormat.sampleRate); const cd=[]; for(let c=0;c<chs;c++)cd[c]=b.getChannelData(c); let off=9; for(let i=0;i<frames;i++)for(let c=0;c<chs;c++){let smp=this.audioFormat.bigEndian?((u8[off]<<8)|u8[off+1]):(u8[off]|(u8[off+1]<<8)); if(this.audioFormat.signed&&smp>=0x8000)smp-=0x10000; cd[c][i]=smp/32768; off+=2;} const src=this.audioCtx.createBufferSource(); src.buffer=b; src.connect(this.audioCtx.destination); const n=this.audioCtx.currentTime; if(!this.audioNext||this.audioNext<n+0.02)this.audioNext=n+0.06; if(this.audioNext>n+0.45)return true; src.start(this.audioNext); this.audioNext+=b.duration; return true; }
  drawLater(){ if(this.raf)return; this.raf=true; requestAnimationFrame(()=>{this.raf=false; if(!this.latest)return; const w=this.config.width,h=this.config.height,p=w*h; if(!this.imageData||this.imageData.width!==w||this.imageData.height!==h)this.imageData=this.ctx.createImageData(w,h); const dst=this.imageData.data,src=this.latest; let codec=this.config.videoCodec; if(src.length>=p*4)codec='rgba'; else if(src.length>=p*2)codec='rgb565'; else codec='rgb332'; if(codec==='rgb565'){for(let i=0,k=0,j=0;i<p;i++,k+=2,j+=4){const v=src[k]|(src[k+1]<<8); dst[j]=((v>>11)&31)*255/31; dst[j+1]=((v>>5)&63)*255/63; dst[j+2]=(v&31)*255/31; dst[j+3]=255;}} else if(codec==='rgb332'){for(let i=0,j=0;i<p;i++,j+=4){const v=src[i]; dst[j]=((v>>5)&7)*255/7; dst[j+1]=((v>>2)&7)*255/7; dst[j+2]=(v&3)*255/3; dst[j+3]=255;}} else {dst.set(src.subarray(0,p*4));} this.ctx.putImageData(this.imageData,0,0);});}
}
global.FreeJ2MEHeadlessClient=FreeJ2MEHeadlessClient;
})(window);
