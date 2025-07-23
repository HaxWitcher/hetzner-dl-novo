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
const TTL_MS    = 3 * 60 * 60 * 1000; // 3 sata

if (!KEY) {
  console.error('❌ Moraš postaviti env var RAPIDAPI_KEY');
  process.exit(1);
}
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log('📂 Kreiran cache dir:', CACHE_DIR);
}

// Držimo Promise za download u toku
const downloads = new Map();

// Health checks
app.get('/', (_req, res) => res.send('OK'));
app.get('/ready', (_req, res) => res.send('OK'));

// HEAD handler da klijenti ne pokreću full GET dvaput
app.head('/stream/:videoId', (_req, res) => res.sendStatus(200));

// 1) Poziv na /mux endpoint
function callMux(videoId) {
  const pathMux = `/mux?id=${encodeURIComponent(videoId)}&quality=1080&codec=h264&audioFormat=best`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      method:  'GET',
      hostname: HOST,
      path:    pathMux,
      headers: {
        'x-rapidapi-key': KEY,
        'x-rapidapi-host': HOST
      }
    }, apiRes => {
      let body = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', c => body += c);
      apiRes.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Nevalidan JSON iz mux API-ja')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 2) Čeka mux URL
async function waitForMux(videoId, maxRetries = 15, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    const json = await callMux(videoId);
    if (json.status === 'tunnel' && json.url) return json.url;
    console.log(`⏳ mux još nije gotov (status=${json.status}), retry ${i+1}/${maxRetries}`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Timeout: mux URL se nije generisao na vreme');
}

// 3) Preuzimanje celog fajla u jedan Promise
function downloadVideo(vid, muxUrl, cachePath) {
  return new Promise((resolve, reject) => {
    const tmpStream = fs.createWriteStream(cachePath);
    https.get(muxUrl, mediaRes => {
      mediaRes.pipe(tmpStream);
      mediaRes.on('end', () => {
        tmpStream.close();
        console.log(`💾 Završeno keširanje ${vid} u ${cachePath}`);
        resolve();
      });
      mediaRes.on('error', err => reject(err));
    }).on('error', err => reject(err));
  });
}

// 4) Glavna ruta
app.get('/stream/:videoId', async (req, res) => {
  const vid       = req.params.videoId;
  const cachePath = path.join(CACHE_DIR, `${vid}.mp4`);

  // Ako je u cache i svež, odmah stream
  if (fs.existsSync(cachePath)) {
    const stats = fs.statSync(cachePath);
    if (Date.now() - stats.mtimeMs < TTL_MS) {
      console.log(`♻️ Koristim keš fajl za ${vid}`);
      res.setHeader('Content-Type', 'video/mp4');
      return fs.createReadStream(cachePath).pipe(res);
    }
    // inače stari brišemo
    fs.unlinkSync(cachePath);
    console.log(`🗑️ Obrišen stari cache za ${vid}`);
  }

  console.log(`➡️ /stream/${vid} — čekam mux i download…`);

  // Ako već neko drugi downloaduje, samo sačekaj
  if (!downloads.has(vid)) {
    // kreiraj novi Promise koji:
    // a) čeka mux URL
    // b) skida ceo fajl
    const promise = (async () => {
      const muxUrl = await waitForMux(vid);
      console.log('✅ mux gotov, skidam kompletan fajl sa:', muxUrl);
      await downloadVideo(vid, muxUrl, cachePath);
    })();
    downloads.set(vid, promise);
    // kada se završi obriši iz mape
    promise.then(() => downloads.delete(vid), () => downloads.delete(vid));
  }

  // Sačekaj da download završi
  try {
    await downloads.get(vid);
  } catch (err) {
    console.error('❌ greška u download-u:', err.message);
    return res.status(502).send(err.message);
  }

  // Sada streamujemo iz fajla
  console.log(`▶️ Streaming preuzetog fajla za ${vid}`);
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(cachePath).pipe(res);
});

app.listen(PORT, () => {
  console.log(`🚀 Server sluša na http://0.0.0.0:${PORT}`);
});
