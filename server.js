const express = require('express');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');

const app       = express();
const PORT      = process.env.PORT || 7860;
const KEY       = process.env.RAPIDAPI_KEY;
const HOST      = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const CACHE_DIR = '/tmp/cache';
if (!KEY) {
  console.error('❌ Moraš postaviti env var RAPIDAPI_KEY');
  process.exit(1);
}
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log('📂 Kreiran cache dir:', CACHE_DIR);
}

// === 1) provjereni callMux + waitForMux ===

function callMux(videoId) {
  const p = `/mux?id=${encodeURIComponent(videoId)}&quality=1080&codec=h264&audioFormat=best`;
  return new Promise((res, rej) => {
    const r = https.request({
      method:  'GET',
      hostname: HOST,
      path:    p,
      headers: {
        'x-rapidapi-key':  KEY,
        'x-rapidapi-host': HOST
      }
    }, apiRes => {
      let body = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', c => body += c);
      apiRes.on('end', () => {
        try { res(JSON.parse(body)); }
        catch (e) { rej(new Error('Nevalidan JSON iz mux API-ja')); }
      });
    });
    r.on('error', rej);
    r.end();
  });
}

async function waitForMux(videoId, retries = 15, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    const j = await callMux(videoId);
    if (j.status==='tunnel' && j.url) return j.url;
    console.log(`⏳ mux status=${j.status}, retry ${i+1}/${retries}`);
    await new Promise(r => setTimeout(r, delay));
  }
  throw new Error('Timeout: mux URL se nije generisao na vreme');
}

// === 2) download cijelog MP4 u cache/VIDEO.mp4 ===

function downloadVideo(url, dest) {
  return new Promise((res, rej) => {
    const ws = fs.createWriteStream(dest);
    https.get(url, r => {
      r.pipe(ws);
      r.on('end', () => { ws.close(); res(); });
      r.on('error', rej);
    }).on('error', rej);
  });
}

// === 3) generisanje HLS ===

function ensureHLS(videoId) {
  const mp4 = path.join(CACHE_DIR, `${videoId}.mp4`);
  const hlsDir = path.join(CACHE_DIR, videoId + '_hls');
  const playlist = path.join(hlsDir, 'master.m3u8');

  // ako već postoji playlist, vraćamo ga
  if (fs.existsSync(playlist)) return Promise.resolve();

  // inače generišemo
  fs.mkdirSync(hlsDir, { recursive: true });

  return new Promise((res, rej) => {
    const ff = spawn('ffmpeg', [
      '-i', mp4,
      '-c', 'copy',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(hlsDir, 'seg%03d.ts'),
      playlist
    ]);
    ff.on('exit', code => {
      if (code === 0) {
        console.log('✅ HLS generisano za', videoId);
        res();
      } else {
        rej(new Error(`ffmpeg exited ${code}`));
      }
    });
  });
}

// === static serve segmenata ===

app.use('/hls/:videoId', express.static(path.join(CACHE_DIR)));


// === glavni endpoint ===

app.get('/stream/:videoId', async (req, res) => {
  const vid = req.params.videoId;
  const mp4 = path.join(CACHE_DIR, `${vid}.mp4`);

  try {
    // 1) čekaj mux url
    console.log(`➡️ /stream/${vid} — priprema...`);
    const muxUrl = await waitForMux(vid);

    // 2) download ako ne postoji
    if (!fs.existsSync(mp4)) {
      console.log(`⬇️ preuzimam MP4 za ${vid}...`);
      await downloadVideo(muxUrl, mp4);
      console.log(`💾 MP4 spreman: ${mp4}`);
    }

    // 3) generiši HLS
    await ensureHLS(vid);

    // 4) redirekcija na playlistu
    const url = `/hls/${vid}/${vid}_hls/master.m3u8`;
    console.log(`▶️ Stream startuje preko HLS: ${url}`);
    res.redirect(url);

  } catch (e) {
    console.error('❌ stream failed:', e);
    res.status(500).send(e.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 sluša na http://0.0.0.0:${PORT}`);  
});
