'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { startTunnel } = require('./lib/tunnel');

// ---------------------------------------------------------------- argumentos
function parseArgs(argv) {
  const opts = { port: 8787, tunnel: 'auto', open: true };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    switch (key) {
      case 'port': opts.port = Number(value) || opts.port; break;
      case 'tunnel': opts.tunnel = value || 'auto'; break;
      case 'no-tunnel': opts.tunnel = 'none'; break;
      case 'open': opts.open = value !== 'false'; break;
      case 'no-open': opts.open = false; break;
      default: break;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const HOST_TOKEN = crypto.randomBytes(16).toString('base64url');
const VIEW_TOKEN = crypto.randomBytes(12).toString('base64url');

const log = (msg) => console.log(msg);

// -------------------------------------------------------------------- estado
const state = {
  host: null,          // ws do apresentador
  hostName: 'Host',
  viewers: new Map(),  // id -> { ws, name, relay }
  nextViewerId: 1,
  relay: {
    active: false,     // host esta gravando com MediaRecorder
    gen: 0,            // geracao atual (muda a cada restart do recorder)
    mime: '',
  },
  publicUrl: null,
};

const send = (ws, obj) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};

const relayViewers = () => [...state.viewers.values()].filter((v) => v.relay);

function broadcastViewers() {
  const list = [...state.viewers.entries()].map(([id, v]) => ({
    id,
    name: v.name,
    mode: v.relay ? 'relay' : 'p2p',
  }));
  send(state.host, { t: 'viewers', list });
  const payload = { t: 'count', n: list.length };
  for (const v of state.viewers.values()) send(v.ws, payload);
}

// Pede ao host para (re)iniciar o MediaRecorder. `restart` indica que ja havia
// uma gravacao rodando e ela precisa recomecar para gerar cabecalho + keyframe
// para quem acabou de entrar.
function requestRelay(restart) {
  if (!state.host) return;
  send(state.host, { t: 'relay-need', restart });
}

function stopRelayIfIdle() {
  if (state.relay.active && relayViewers().length === 0) {
    state.relay.active = false;
    send(state.host, { t: 'relay-stop' });
  }
}

// ----------------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.use('/static/js', express.static(path.join(__dirname, 'public', 'js'), { maxAge: '1h' }));
app.use('/static/css', express.static(path.join(__dirname, 'public', 'css'), { maxAge: '1h' }));

const sendPage = (res, file) => res.sendFile(path.join(__dirname, 'public', file));

app.get('/h/:token', (req, res) => {
  if (req.params.token !== HOST_TOKEN) {
    res.status(403);
    return sendPage(res, 'denied.html');
  }
  return sendPage(res, 'host.html');
});

app.get('/j/:token', (req, res) => {
  if (req.params.token !== VIEW_TOKEN) {
    res.status(403);
    return sendPage(res, 'denied.html');
  }
  return sendPage(res, 'viewer.html');
});

// Alguem abrindo a raiz do tunel entra como espectador.
app.get('/', (req, res) => res.redirect(`/j/${VIEW_TOKEN}`));

app.get('/api/session', (req, res) => {
  if (req.query.k !== HOST_TOKEN) return res.status(403).json({ error: 'forbidden' });
  const local = `http://localhost:${opts.port}/j/${VIEW_TOKEN}`;
  res.json({
    viewUrl: state.publicUrl ? `${state.publicUrl}/j/${VIEW_TOKEN}` : local,
    localUrl: local,
    tunnel: Boolean(state.publicUrl),
  });
});

app.use((req, res) => {
  res.status(404);
  sendPage(res, 'denied.html');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024 });

// --------------------------------------------------------------- sinalizacao
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('k');
  const name = (url.searchParams.get('name') || '').slice(0, 32);

  if (token === HOST_TOKEN) return attachHost(ws, name);
  if (token === VIEW_TOKEN) return attachViewer(ws, name);
  ws.close(4003, 'token invalido');
});

function attachHost(ws, name) {
  if (state.host && state.host !== ws) state.host.close(4000, 'outra aba assumiu a transmissao');
  state.host = ws;
  state.hostName = name || 'Host';
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, { t: 'joined', role: 'host' });
  broadcastViewers();
  for (const v of state.viewers.values()) send(v.ws, { t: 'host-online' });
  // Se alguem ja estava assistindo pelo relay, a nova aba precisa retomar a
  // gravacao — senao essas pessoas ficam sem imagem.
  if (relayViewers().length) requestRelay(false);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Chunk de video do modo relay.
      for (const v of relayViewers()) {
        if (v.ws.readyState === 1) v.ws.send(data, { binary: true });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.t) {
      case 'signal': {
        const viewer = state.viewers.get(msg.to);
        if (viewer) send(viewer.ws, { t: 'signal', data: msg.data });
        break;
      }
      case 'relay-start': {
        // Nova geracao: zera o buffer e reinicia o MSE de todo mundo em relay.
        state.relay.active = true;
        state.relay.gen += 1;
        state.relay.mime = msg.mime;
        for (const v of relayViewers()) {
          send(v.ws, { t: 'relay-start', mime: msg.mime, gen: state.relay.gen });
        }
        break;
      }
      case 'relay-stopped':
        state.relay.active = false;
        break;
      case 'chat': {
        const text = String(msg.text || '').slice(0, 500);
        if (!text) break;
        for (const v of state.viewers.values()) {
          send(v.ws, { t: 'chat', name: state.hostName, text });
        }
        break;
      }
      case 'kick': {
        const viewer = state.viewers.get(msg.id);
        if (viewer) viewer.ws.close(4008, 'removido pelo host');
        break;
      }
      case 'idle':
        for (const v of state.viewers.values()) send(v.ws, { t: 'host-idle' });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (state.host !== ws) return;
    state.host = null;
    state.relay.active = false;
    for (const v of state.viewers.values()) send(v.ws, { t: 'host-offline' });
  });
}

function attachViewer(ws, name) {
  const id = state.nextViewerId++;
  const viewer = { ws, name: name || `Convidado ${id}`, relay: false };
  state.viewers.set(id, viewer);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, { t: 'joined', role: 'viewer', id, hostOnline: Boolean(state.host) });
  if (state.host) send(state.host, { t: 'viewer-join', id, name: viewer.name });
  broadcastViewers();

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.t) {
      case 'signal':
        send(state.host, { t: 'signal', from: id, data: msg.data });
        break;
      case 'relay-on':
        if (viewer.relay) break;
        viewer.relay = true;
        // Sempre pede restart: garante cabecalho + keyframe para quem chegou.
        requestRelay(state.relay.active);
        broadcastViewers();
        break;
      case 'relay-off':
        if (!viewer.relay) break;
        viewer.relay = false;
        stopRelayIfIdle();
        send(state.host, { t: 'viewer-p2p', id });
        broadcastViewers();
        break;
      case 'chat': {
        const text = String(msg.text || '').slice(0, 500);
        if (!text) break;
        send(state.host, { t: 'chat', from: id, name: viewer.name, text });
        for (const [otherId, v] of state.viewers) {
          if (otherId !== id) send(v.ws, { t: 'chat', name: viewer.name, text });
        }
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    state.viewers.delete(id);
    if (state.host) send(state.host, { t: 'viewer-left', id });
    stopRelayIfIdle();
    broadcastViewers();
  });
}

// Mantem as conexoes vivas atraves do tunel, que derruba sockets ociosos.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);
wss.on('close', () => clearInterval(heartbeat));

// --------------------------------------------------------------------- start
// O DNS do quick tunnel leva alguns segundos para propagar. Sem esta espera o
// link e impresso antes de funcionar, e o convidado ve um erro de DNS.
async function waitForPublicUrl(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return true;
    } catch { /* ainda propagando */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* abrir o navegador e opcional */ }
}

let tunnel = null;

server.listen(opts.port, async () => {
  const hostUrl = `http://localhost:${opts.port}/h/${HOST_TOKEN}`;

  if (opts.tunnel !== 'none') {
    log('\nabrindo tunel publico...');
    try {
      tunnel = await startTunnel(opts.port, opts.tunnel, log);
      state.publicUrl = tunnel.url;
    } catch (err) {
      log(`nao consegui abrir o tunel: ${err.message}`);
      log('seguindo apenas em rede local (use --no-tunnel para pular esta etapa)');
    }
  }

  const viewUrl = state.publicUrl
    ? `${state.publicUrl}/j/${VIEW_TOKEN}`
    : `http://localhost:${opts.port}/j/${VIEW_TOKEN}`;

  let ready = true;
  if (state.publicUrl) {
    log('validando o link publico...');
    ready = await waitForPublicUrl(viewUrl);
  }

  log('');
  log('==================================================');
  log('  SHARE SCREEN no ar');
  log('==================================================');
  log(`  Seu painel (host):  ${hostUrl}`);
  log(`  Link p/ convidados: ${viewUrl}`);
  if (!ready) {
    log('  (o DNS deste endereco ainda esta propagando; se der erro,');
    log('   peca para tentar de novo em alguns segundos)');
  }
  if (tunnel && tunnel.provider === 'localtunnel') {
    log('  (localtunnel pede uma senha na primeira visita: e o seu IP publico,');
    log('   consulte em https://ipv4.icanhazip.com)');
  }
  log('==================================================');
  log('');
  log('Ctrl+C encerra a transmissao e fecha o tunel.');
  log('');

  if (opts.open) openBrowser(hostUrl);
});

function shutdown() {
  log('\nencerrando...');
  clearInterval(heartbeat);
  if (tunnel) { try { tunnel.stop(); } catch { /* ja morreu */ } }
  for (const ws of wss.clients) ws.close(1001, 'servidor encerrado');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
