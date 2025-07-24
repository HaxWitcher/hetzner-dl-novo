const express = require('express');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = process.env.PORT || 7860;
const KEY       = process.env.RAPIDAPI_KEY;
const HOST      = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';
const CACHE_DIR = '/tmp/cache';
// umjesto 100 KB sad čeka 50 MB
const MIN_CHUNK = 50 * 1024 * 1024;    // 50MB

if (!KEY) {
  console.error('❌ RAPIDAPI_KEY nije postavljen');
  process.exit(1);
}
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// mapa: videoId → Promise download‑a
const jobs = new Map();

// Health
app.get('/', (_q,r)=>r.send('OK'));
app.get('/ready', (_q,r)=>r.send('OK'));

function callMux(videoId) {
  const pathMux = `/mux?id=${encodeURIComponent(videoId)}&quality=1080&codec=h264&audioFormat=best`;
  return new Promise((res,rej)=>{
    const req = https.request({method:'GET',hostname:HOST,path:pathMux,headers:{
      'x-rapidapi-key':KEY,'x-rapidapi-host':HOST
    }}, r=>{
      let b='';
      r.setEncoding('utf8');
      r.on('data',c=>b+=c);
      r.on('end',()=>{
        try { res(JSON.parse(b)); }
        catch { rej(new Error('Invalid JSON')); }
      });
    });
    req.on('error', rej);
    req.end();
  });
}

async function waitForMux(videoId) {
  for (let i=0;i<15;i++){
    const j = await callMux(videoId).catch(()=>null);
    if (j?.status==='tunnel'&&j.url) return j.url;
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('mux timeout');
}

function downloadResume(muxUrl, file){
  return new Promise((res,rej)=>{
    const start = fs.existsSync(file)? fs.statSync(file).size : 0;
    const opts = new URL(muxUrl);
    opts.headers = { Range: `bytes=${start}-` };
    https.get(opts, r=>{
      if (r.statusCode>=400) return rej(new Error('HTTP '+r.statusCode));
      const ws = fs.createWriteStream(file,{flags:start?'a':'w'});
      r.pipe(ws);
      ws.on('finish', ()=>res());
      ws.on('error', rej);
    }).on('error', rej);
  });
}

function tailStream(file, res){
  let pos = 0;
  const serve = ()=>{
    const rs = fs.createReadStream(file,{start:pos});
    rs.on('data',chunk=>{
      pos += chunk.length;
      res.write(chunk);
    });
    rs.on('end',()=>{
      const watcher = setInterval(()=>{
        const sz = fs.statSync(file).size;
        if (sz > pos){
          clearInterval(watcher);
          serve();
        }
      },250);
    });
    rs.on('error',e=>res.destroy(e));
  };
  serve();
}

app.head('/stream/:videoId', (_q,r)=>r.sendStatus(200));

app.get('/stream/:videoId', async (req, res) => {
  const vid  = req.params.videoId;
  const file = path.join(CACHE_DIR, vid+'.mp4');

  if (!jobs.has(vid)) {
    const job = (async ()=>{
      const muxUrl = await waitForMux(vid);
      console.log(`✅ mux ${vid}: ${muxUrl}`);
      await downloadResume(muxUrl, file);
      console.log(`💾 complete ${vid}`);
    })();
    jobs.set(vid, job);
    job.then(()=>jobs.delete(vid), ()=>jobs.delete(vid));
  }

  // čekanje na početni buffer
  let t0 = Date.now();
  while (true) {
    if (fs.existsSync(file) && fs.statSync(file).size >= MIN_CHUNK) break;
    if (Date.now() - t0 > 20_000) break; // maksimalno 20s čekanja
    await new Promise(r=>setTimeout(r,200));
  }

  res.setHeader('Content-Type','video/mp4');
  tailStream(file, res);
});

app.listen(PORT, ()=>console.log(`🚀 na http://0.0.0.0:${PORT}`));
