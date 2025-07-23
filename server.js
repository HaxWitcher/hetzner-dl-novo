// server.js
const express = require('express');
const https   = require('https');
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = process.env.PORT || 7860;
const KEY       = process.env.RAPIDAPI_KEY;
const HOST      = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

if (!KEY) {
  console.error('❌ Moraš postaviti env var RAPIDAPI_KEY');
  process.exit(1);
}

// helper: dobij mux URL (kopirano 1:1 od tebe)
function callMux(videoId) {
  const pathMux = `/mux?id=${encodeURIComponent(videoId)}&quality=1080&codec=h264&audioFormat=best`;
  return new Promise((resolve, reject) => {
    const req = https.request({ method:'GET', hostname:HOST, path:pathMux, headers:{
        'x-rapidapi-key': KEY,
        'x-rapidapi-host': HOST
      }
    }, apiRes => {
      let body = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', c => body += c);
      apiRes.on('end', () => {
        try { resolve(JSON.parse(body).url); }
        catch (e) { reject(new Error('Nevalidan JSON iz mux API-ja')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// čekaj dok ne dobijemo URL
async function waitForMux(videoId) {
  for (let i = 0; i < 15; i++) {
    try {
      const url = await callMux(videoId);
      if (url) return url;
    } catch(_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Timeout: mux URL se nije generisao na vreme');
}

app.get('/stream/:videoId', async (req, res) => {
  const vid = req.params.videoId;
  console.log(`➡️ /stream/${vid} — priprema fMP4 toka…`);

  let muxUrl;
  try {
    muxUrl = await waitForMux(vid);
    console.log('✅ dobili mux URL:', muxUrl);
  } catch (err) {
    console.error('❌ mux error:', err.message);
    return res.status(502).send(err.message);
  }

  // podesi header-e za MP4 fMP4 streaming
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Transfer-Encoding', 'chunked');

  // spawn ffmpeg da iz muxUrl pravi fragmentirani MP4
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', muxUrl,
    '-c', 'copy',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ]);

  ff.stdout.pipe(res);
  ff.stderr.on('data', d => {
    // možeš pôstaviti debug log ovde, ali filterišući samo važne poruke
  });

  ff.on('close', code => {
    console.log(`🔴 ffmpeg exited (${code}) for ${vid}`);
    res.end();
  });

  // kada klijent prekine konekciju, ubijemo ffmpeg
  req.on('close', () => {
    ff.kill('SIGKILL');
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server sluša na http://0.0.0.0:${PORT}`);
});
