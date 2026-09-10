'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.share-screen');

// Mapeia plataforma/arquitetura para o asset publicado nos releases do cloudflared.
function cloudflaredAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
  if (!arch) return null;
  if (process.platform === 'win32') return { name: `cloudflared-windows-${arch}.exe`, bin: 'cloudflared.exe' };
  if (process.platform === 'darwin') return null; // release em .tgz, nao vale a pena descompactar aqui
  if (process.platform === 'linux') return { name: `cloudflared-linux-${arch}`, bin: 'cloudflared' };
  return null;
}

function whichCloudflared() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['cloudflared'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    const first = r.stdout.split(/\r?\n/).find((l) => l.trim());
    if (first) return first.trim();
  }
  return null;
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('redirecionamentos demais'));
    https
      .get(url, { headers: { 'User-Agent': 'share-screen' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, onProgress, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} ao baixar cloudflared`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const tmp = `${dest}.part`;
        const file = fs.createWriteStream(tmp);
        res.on('data', (c) => {
          got += c.length;
          if (onProgress) onProgress(got, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          fs.renameSync(tmp, dest);
          resolve(dest);
        }));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function ensureCloudflared(log) {
  const found = whichCloudflared();
  if (found) return found;

  const asset = cloudflaredAsset();
  if (!asset) return null;

  const dest = path.join(CACHE_DIR, asset.bin);
  if (fs.existsSync(dest)) return dest;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.name}`;
  log(`baixando cloudflared (uma vez so) -> ${dest}`);

  let lastPct = -1;
  await download(url, dest, (got, total) => {
    if (!total) return;
    const pct = Math.floor((got / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      log(`  download ${pct}%`);
    }
  });
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  return dest;
}

// Quick tunnel do Cloudflare: sem conta, HTTPS valido, URL *.trycloudflare.com.
function startCloudflared(bin, port, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('cloudflared nao devolveu uma URL em 45s'));
    }, 45000);

    const scan = (buf) => {
      const text = buf.toString();
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: m[0], stop: () => child.kill(), provider: 'cloudflared' });
      }
    };

    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared saiu com codigo ${code}`));
    });
  });
}

async function startLocaltunnel(port) {
  const localtunnel = require('localtunnel');
  const t = await localtunnel({ port });
  return { url: t.url, stop: () => t.close(), provider: 'localtunnel' };
}

/**
 * Sobe um tunel publico apontando para a porta local.
 * @param {number} port
 * @param {'auto'|'cloudflared'|'localtunnel'} provider
 * @param {(msg:string)=>void} log
 */
async function startTunnel(port, provider, log) {
  if (provider === 'cloudflared' || provider === 'auto') {
    try {
      const bin = await ensureCloudflared(log);
      if (bin) return await startCloudflared(bin, port, log);
      if (provider === 'cloudflared') throw new Error('cloudflared indisponivel nesta plataforma');
      log('cloudflared indisponivel nesta plataforma, tentando localtunnel');
    } catch (err) {
      if (provider === 'cloudflared') throw err;
      log(`cloudflared falhou (${err.message}), tentando localtunnel`);
    }
  }
  return startLocaltunnel(port);
}

module.exports = { startTunnel };
