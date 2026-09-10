/* Utilidades compartilhadas entre o painel do host e a pagina do espectador. */
'use strict';

const SS = (() => {
  const el = (id) => document.getElementById(id);

  // O token vive no proprio caminho: /h/<token> (host) ou /j/<token> (viewer).
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');

  const ICE = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: ['stun:stun.cloudflare.com:3478'] },
    ],
    // Se voce tiver um TURN proprio, some-o acima: sem TURN, redes muito
    // restritivas caem automaticamente no modo relay via WebSocket.
    bundlePolicy: 'max-bundle',
  };

  let toastTimer = null;
  function toast(text, ms = 2600) {
    const box = el('toast');
    if (!box) return;
    box.textContent = text;
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('show'), ms);
  }

  /**
   * Conexao de sinalizacao com reconexao automatica (o tunel derruba sockets
   * ociosos ou instaveis com alguma frequencia).
   */
  function connect({ name, onJson, onBinary, onOpen, onClose }) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws = null;
    let closed = false;
    let attempt = 0;
    let currentName = name || '';

    const open = () => {
      const qs = new URLSearchParams({ k: token, name: currentName });
      ws = new WebSocket(`${proto}//${location.host}/ws?${qs}`);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        attempt = 0;
        if (onOpen) onOpen();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (onJson) onJson(msg);
        } else if (onBinary) {
          onBinary(ev.data);
        }
      };
      ws.onclose = (ev) => {
        if (onClose) onClose(ev);
        if (closed || ev.code === 4003 || ev.code === 4008 || ev.code === 4000) return;
        attempt += 1;
        setTimeout(open, Math.min(1000 * attempt, 8000));
      };
      ws.onerror = () => { /* onclose cuida da reconexao */ };
    };

    open();

    return {
      send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
      sendBinary(buf) { if (ws && ws.readyState === 1) ws.send(buf); },
      get bufferedAmount() { return ws && ws.readyState === 1 ? ws.bufferedAmount : 0; },
      setName(value) { currentName = value; },
      close() { closed = true; if (ws) ws.close(); },
    };
  }

  function setupChat({ conn, logId = 'chatLog', formId = 'chatForm', inputId = 'chatInput', me = 'Você' }) {
    const log = el(logId);
    const form = el(formId);
    const input = el(inputId);

    const append = (node) => {
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      log.appendChild(node);
      if (stick) log.scrollTop = log.scrollHeight;
    };

    const line = (who, text) => {
      const div = document.createElement('div');
      div.className = 'msg';
      const b = document.createElement('b');
      b.textContent = `${who}: `;
      div.append(b, document.createTextNode(text));
      append(div);
    };

    const system = (text) => {
      const div = document.createElement('div');
      div.className = 'sys';
      div.textContent = text;
      append(div);
    };

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      conn.send({ t: 'chat', text });
      line(me, text);
      input.value = '';
    });

    return { line, system };
  }

  const fmtBits = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`);

  function setStatus(text, kind) {
    const pill = el('statusPill');
    if (!pill) return;
    pill.textContent = text;
    pill.className = `pill${kind ? ` ${kind}` : ''}`;
  }

  function setLive(on) {
    const dot = el('liveDot');
    if (dot) dot.classList.toggle('live', Boolean(on));
  }

  return { el, token, ICE, toast, connect, setupChat, fmtBits, setStatus, setLive };
})();
