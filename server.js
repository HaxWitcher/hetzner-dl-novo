const express = require('express');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = process.env.PORT || 7860;
const KEY       = process.env.RAPIDAPI_KEY;
const HOST      = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';
const CACHE_DIR = '/tmp/cache';
const TTL_MS    = 3 * 60 * 60 * 1000; // 3h

if (!KEY) {
  console.error('❌ RAPIDAPI_KEY nije postavljen');
  process.exit(1);
}
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Health checks
app.get('/',    (_req, res) => res.send('OK'));
app.get('/ready',(_req, res) => res.send('OK'));

function callMux(videoId) {
  const pathMux = `/mux?id=${encodeURIComponent(videoId)}&quality=1080&codec=h264&audioFormat=best`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET',
      hostname: HOST,
      path: pathMux,
      headers: {
        'x-rapidapi-key': KEY,
        'x-rapidapi-host': HOST
      }
    }, apiRes => {
      let b = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', c => b += c);
      apiRes.on('end', ()=> {
        try { resolve(JSON.parse(b)); }
        catch(_){ reject(new Error('Nevalidan JSON iz mux API-ja')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForMux(videoId) {
  for (let i=0; i<15; i++) {
    const j = await callMux(videoId).catch(()=>null);
    if (j?.status==='tunnel' && j.url) return j.url;
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('Timeout: mux URL nije gotov');
}

// Download + resume
function downloadWithResume(videoId, muxUrl, cachePath) {
  return new Promise((resolve, reject) => {
    const start = fs.existsSync(cachePath) ? fs.statSync(cachePath).size : 0;
    const opts = new URL(muxUrl);
    opts.headers = { Range: `bytes=${start}-` };
    https.get(opts, mediaRes => {
      if (mediaRes.statusCode >= 400) return reject(new Error(`HTTP ${mediaRes.statusCode}`));
      const ws = fs.createWriteStream(cachePath, { flags: start? 'a':'w' });
      mediaRes.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    }).on('error', reject);
  });
}

// Tail‑reader: streamuje rastući fajl
function tailStream(cachePath, res) {
  let pos = 0;
  const stream = () => {
    const rs = fs.createReadStream(cachePath, { start: pos });
    rs.on('data', chunk => {
      pos += chunk.length;
      res.write(chunk);
    });
    rs.on('end', ()=> {
      // kad dosegnemo kraj, pričekaj na novi podatak
      fs.watchFile(cachePath, { interval: 500 }, (curr, prev) => {
        if (curr.size > prev.size) {
          fs.unwatchFile(cachePath);
          stream();
        }
      });
    });
    rs.on('error', err => res.destroy(err));
  };
  stream();
}

app.get('/stream/:videoId', async (req, res) => {
  const vid  = req.params.videoId;
  const file = path.join(CACHE_DIR, `${vid}.mp4`);

  try {
    // 1) dobij mux URL
    console.log(`➡️ waitForMux(${vid})`);
    const muxUrl = await waitForMux(vid);
    console.log(`✅ mux URL: ${muxUrl}`);

    // 2) startuj download+resume u pozadini
    console.log(`⬇️ downloadWithResume start`);
    downloadWithResume(vid, muxUrl, file)
      .then(()=> console.log(`💾 download complete: ${file}`))
      .catch(e=> console.error(`❌ download error:`, e));

    // 3) odmah digni response
    res.setHeader('Content-Type','video/mp4');
    tailStream(file, res);

  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

app.listen(PORT, ()=>console.log(`🚀 na http://0.0.0.0:${PORT}`));
