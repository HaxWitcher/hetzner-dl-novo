// server.js
const express = require('express');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = process.env.PORT || 7860;
const KEY       = process.env.RAPIDAPI_KEY;
const HOST      = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';
const CACHE_DIR = '/tmp/cache';
const MIN_CHUNK = 50 * 1024 * 1024;    // 50 MB

if (!KEY) {
  console.error('❌ RAPIDAPI_KEY nije postavljen');
  process.exit(1);
}
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// mapa: videoId → { promise: Promise, muxUrl: string }
const jobs = new Map();

// Health
app.get('/', (_q,r)=>r.send('OK'));
app.get('/ready', (_q,r)=>r.send('OK'));
app.head('/stream/:videoId', (_q,r)=>r.sendStatus(200));

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

function tailStream(file, res, downloadPromise){
  let pos = 0;
  let watching = true;

  const serve = () => {
    const rs = fs.createReadStream(file,{start:pos});
    rs.on('data',chunk=>{
      pos += chunk.length;
      res.write(chunk);
    });
    rs.on('end', async () => {
      // ako download još traje, čekaj nove bajtove...
      if (watching) {
        const watcher = setInterval(() => {
          const sz = fs.statSync(file).size;
          if (sz > pos) {
            clearInterval(watcher);
            serve();
          }
        }, 200);
        // ali i prekini watcher kad download završi i nema novih bajtova
        downloadPromise.finally(() => {
          clearInterval(watcher);
          watching = false;
          // ako smo došli do kraja, end stream
          const finalSize = fs.statSync(file).size;
          if (pos >= finalSize) res.end();
        });
      } else {
        res.end();
      }
    });
    rs.on('error',e=>{
      console.error('❌ tailStream error:', e);
      res.destroy(e);
    });
  };

  serve();
}

app.get('/stream/:videoId', async (req, res) => {
  const vid  = req.params.videoId;
  const file = path.join(CACHE_DIR, vid+'.mp4');

  // startuj posao ako već ne postoji
  if (!jobs.has(vid)) {
    const job = (async ()=> {
      const muxUrl = await waitForMux(vid);
      console.log(`✅ mux ${vid}: ${muxUrl}`);
      await downloadResume(muxUrl, file);
      console.log(`💾 complete ${vid}`);
    })();
    jobs.set(vid, job);
    job.finally(()=> jobs.delete(vid));
  }
  const jobPromise = jobs.get(vid);

  // sačekaj barem MIN_CHUNK bajtova (ili max 10s)
  const start = Date.now();
  while ((!fs.existsSync(file) || fs.statSync(file).size < MIN_CHUNK) && Date.now()-start < 10_000) {
    await new Promise(r=>setTimeout(r,200));
  }

  res.setHeader('Content-Type','video/mp4');
  tailStream(file, res, jobPromise);
});

app.listen(PORT, ()=>console.log(`🚀 na http://0.0.0.0:${PORT}`));
