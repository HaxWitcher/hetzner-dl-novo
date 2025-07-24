// server.js
const express = require('express');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = process.env.NODE_PORT || 7861;      // unutrašnji port
const KEY       = process.env.RAPIDAPI_KEY;
const HOST      = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';
const CACHE_DIR = '/tmp/cache';
const MIN_CHUNK = 30 * 1024 * 1024;    // 30 MB

if (!KEY) {
  console.error('❌ RAPIDAPI_KEY nije postavljen');
  process.exit(1);
}
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// videoId → Promise za download
const jobs = new Map();

// health
app.get('/', (_req, res) => res.send('OK'));
app.get('/ready', (_req, res) => res.send('OK'));

// 1) /mux poziv
function callMux(id) {
  const p = `/mux?id=${encodeURIComponent(id)}&quality=1080&codec=h264&audioFormat=best`;
  return new Promise((r,j)=>{
    const req = https.request({
      method: 'GET', hostname: HOST, path: p,
      headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST }
    }, apiRes => {
      let b = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', c=> b+=c);
      apiRes.on('end', ()=> {
        try { r(JSON.parse(b)); }
        catch(e){ j(new Error('Invalid JSON')); }
      });
    });
    req.on('error', j);
    req.end();
  });
}

// 2) čekaj tunnel URL
async function waitForMux(id) {
  for (let i=0; i<15; i++) {
    const j = await callMux(id).catch(()=>null);
    if (j?.status==='tunnel' && j.url) return j.url;
    await new Promise(x=>setTimeout(x,1000));
  }
  throw new Error('mux timeout');
}

// 3) download sa resume podrškom
function downloadResume(muxUrl, file) {
  return new Promise((r,j)=>{
    const start = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const opts = new URL(muxUrl);
    opts.headers = { Range: `bytes=${start}-` };
    https.get(opts, res => {
      if (res.statusCode >= 400) return j(new Error('HTTP '+res.statusCode));
      const ws = fs.createWriteStream(file, { flags: start ? 'a' : 'w' });
      res.pipe(ws);
      ws.on('finish', ()=> r());
      ws.on('error', j);
    }).on('error', j);
  });
}

// 4) route
app.get('/stream/:videoId', async (req, res) => {
  const vid  = req.params.videoId;
  const file = path.join(CACHE_DIR, vid + '.mp4');

  // startuj download ako već nije
  if (!jobs.has(vid)) {
    const p = (async () => {
      const muxUrl = await waitForMux(vid);
      console.log(`✅ mux ${vid}: ${muxUrl}`);
      await downloadResume(muxUrl, file);
      console.log(`💾 complete ${vid}`);
    })().catch(e => {
      console.error(`❌ download ${vid} error:`, e.message);
      fs.existsSync(file) && fs.unlinkSync(file);
      jobs.delete(vid);
    });
    jobs.set(vid, p);
    p.then(() => jobs.delete(vid));
  }

  // pričekaj početni blok
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    if (fs.existsSync(file) && fs.statSync(file).size >= MIN_CHUNK) break;
    await new Promise(x=>setTimeout(x,200));
  }

  // preusmjeri klijenta na nginx statički endpoint
  return res.redirect(302, `/cache/${vid}.mp4`);
});

app.listen(PORT, ()=> console.log(`🚀 Node sluša na http://0.0.0.0:${PORT}`));
