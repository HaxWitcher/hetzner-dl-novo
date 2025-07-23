const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app  = express();
const PORT = process.env.PORT || 7860;
const KEY  = process.env.RAPIDAPI_KEY;
const HOST = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const CACHE_ROOT = '/tmp/cache';
if (!KEY) {
  console.error('❌ Moraš postaviti env var RAPIDAPI_KEY');
  process.exit(1);
}
if (!fs.existsSync(CACHE_ROOT)) {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
}

// --- Mux helper (1:1 tvoj kod) ---
function callMux(videoId) {
  const pathMux = `/mux?id=${encodeURIComponent(videoId)}&quality=1080&codec=h264&audioFormat=best`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      method:  'GET',
      hostname: HOST,
      path:    pathMux,
      headers: {
        'x-rapidapi-key':  KEY,
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

async function waitForMux(videoId, maxRetries = 15, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    const json = await callMux(videoId);
    if (json.status === 'tunnel' && json.url) {
      return json.url;
    }
    console.log(`⏳ mux još nije gotov (status=${json.status}), retry ${i+1}`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Timeout: mux URL se nije generisao na vreme');
}

// --- Spawn FFmpeg to HLS ---
function ensureHls(videoId, muxUrl) {
  const dir = path.join(CACHE_ROOT, videoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // ako FFmpeg već radi, vratimo
  if (processes.has(videoId)) return processes.get(videoId);

  // Output: playlist and 4s segments
  const args = [
    '-i', muxUrl,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_flags', 'delete_segments',
    path.join(dir, 'index.m3u8')
  ];
  const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
  ff.on('exit', (code) => {
    console.log(`FFmpeg za ${videoId} završio s ${code}`);
    processes.delete(videoId);
  });
  processes.set(videoId, ff);
  return ff;
}

const processes = new Map();

// --- Serve HLS dirs statically ---
app.use('/hls/:videoId', async (req, res, next) => {
  const vid = req.params.videoId;
  try {
    // 1) dobij muxUrl
    const muxUrl = await waitForMux(vid);
    console.log(`✅ mux URL za ${vid}: ${muxUrl}`);
    // 2) start FFmpeg HLS
    ensureHls(vid, muxUrl);
    // 3) serve static files
    express.static(path.join(CACHE_ROOT, vid))(req, res, next);

  } catch (err) {
    console.error('❌ HLS error:', err);
    res.status(502).send(err.message);
  }
});

// health
app.get('/', (_req, res) => res.send('OK'));
app.get('/ready', (_req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`🚀 HLS proxy na http://0.0.0.0:${PORT}/hls/:videoId/index.m3u8`);
});
