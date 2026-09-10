/* Pagina do espectador: tenta WebRTC direto e, se a conexao nao fechar,
   cai para o fluxo repassado pelo servidor (WebSocket + Media Source). */
'use strict';

(() => {
  const { el, ICE } = SS;

  const stage = el('stage');
  const video = el('video');
  const phTitle = el('phTitle');
  const phText = el('phText');
  const btnSound = el('btnSound');
  const btnFull = el('btnFull');
  const btnRelay = el('btnRelay');
  const countPill = el('countPill');
  const modePill = el('modePill');
  const nick = el('nick');
  const btnNick = el('btnNick');

  const P2P_TIMEOUT = 12000; // sem imagem depois disso, tenta o modo relay

  let pc = null;
  let signalChain = Promise.resolve(); // aplica os sinais em ordem
  let pendingCandidates = [];          // candidatos chegados antes da oferta
  let relayOn = false;
  let hostOnline = false;
  let gotMedia = false;
  let p2pTimer = null;

  // Estado do modo relay (Media Source Extensions).
  let mediaSource = null;
  let sourceBuffer = null;
  let queue = [];

  const savedNick = localStorage.getItem('ss-nick') || '';
  nick.value = savedNick;

  // ------------------------------------------------------------- sinalizacao
  const conn = SS.connect({
    name: savedNick,
    onJson: handleMessage,
    onBinary: onChunk,
    onOpen: () => {
      SS.setStatus(hostOnline ? 'conectando…' : 'aguardando o host');
      // Reconectou: o servidor nos ve como alguem novo, entao e preciso pedir
      // o relay de novo para quem estava nesse modo.
      if (relayOn) conn.send({ t: 'relay-on' });
    },
    onClose: (ev) => {
      if (ev.code === 4008) {
        SS.setStatus('removido pelo host', 'bad');
        setPlaceholder('Você foi removido', 'O host encerrou seu acesso a esta sessão.');
      } else if (ev.code === 4003) {
        SS.setStatus('link inválido', 'bad');
        setPlaceholder('Link inválido', 'Peça um link novo para quem está transmitindo.');
      } else {
        SS.setStatus('reconectando…', 'warn');
      }
    },
  });

  const chat = SS.setupChat({ conn, me: savedNick || 'Você' });

  function handleMessage(msg) {
    switch (msg.t) {
      case 'joined':
        hostOnline = msg.hostOnline;
        SS.setStatus(hostOnline ? 'conectando…' : 'aguardando o host');
        if (hostOnline) armP2PTimeout();
        break;
      case 'host-online':
        hostOnline = true;
        SS.setStatus('conectando…');
        setPlaceholder('Aguardando a transmissão…', 'O host está online.');
        armP2PTimeout();
        break;
      case 'host-offline':
        hostOnline = false;
        teardownMedia();
        SS.setStatus('host offline', 'warn');
        setPlaceholder('O host saiu', 'A página reconecta sozinha assim que ele voltar.');
        break;
      case 'host-idle':
        teardownMedia();
        SS.setStatus('transmissão pausada', 'warn');
        setPlaceholder('Transmissão encerrada', 'O host parou de compartilhar a tela.');
        break;
      case 'signal':
        onSignal(msg.data);
        break;
      case 'relay-start':
        startRelayPlayback(msg.mime);
        break;
      case 'count':
        countPill.textContent = `${msg.n} assistindo`;
        break;
      case 'chat':
        chat.line(msg.name, msg.text);
        break;
      default:
        break;
    }
  }

  function setPlaceholder(title, text) {
    phTitle.textContent = title;
    phText.textContent = text;
  }

  function showVideo() {
    gotMedia = true;
    stage.classList.add('has-video');
    SS.setLive(true);
    SS.setStatus('assistindo', 'ok');
    clearTimeout(p2pTimer);
    video.play().catch(() => { /* autoplay bloqueado; o botao de som resolve */ });
  }

  function teardownMedia() {
    gotMedia = false;
    stage.classList.remove('has-video');
    SS.setLive(false);
    closePc();
    stopRelayPlayback();
  }

  // -------------------------------------------------------------- WebRTC P2P
  function ensurePc() {
    if (pc) return pc;
    pc = new RTCPeerConnection(ICE);

    pc.ontrack = (ev) => {
      if (video.srcObject !== ev.streams[0]) {
        video.srcObject = ev.streams[0];
        video.removeAttribute('src');
      }
      setMode('direto');
      showVideo();
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) conn.send({ t: 'signal', data: { candidate: ev.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'failed') {
        if (!relayOn) enableRelay(true);
      }
    };
    return pc;
  }

  function onSignal(data) {
    signalChain = signalChain.then(async () => {
      // Em modo relay o P2P esta desligado: uma oferta atrasada nao pode
      // reabrir uma conexao que o host ja descartou.
      if (relayOn) return;
      try {
        if (data.sdp && data.sdp.type === 'offer') {
          // Oferta nova em cima de uma sessao ja negociada = o host recomecou
          // a transmitir; a conexao antiga nao serve mais.
          if (pc && pc.currentRemoteDescription) closePc();
          const conexao = ensurePc();
          await conexao.setRemoteDescription(data.sdp);
          const answer = await conexao.createAnswer();
          await conexao.setLocalDescription(answer);
          conn.send({ t: 'signal', data: { sdp: conexao.localDescription } });
          await flushCandidates();
        } else if (data.sdp && pc) {
          await pc.setRemoteDescription(data.sdp);
          await flushCandidates();
        } else if (data.candidate) {
          if (!pc || !pc.remoteDescription) pendingCandidates.push(data.candidate);
          else await pc.addIceCandidate(data.candidate);
        }
      } catch (err) {
        console.warn('sinal ignorado', err);
      }
    });
  }

  async function flushCandidates() {
    if (!pc) return;
    for (const c of pendingCandidates.splice(0)) {
      await pc.addIceCandidate(c).catch(() => {});
    }
  }

  function closePc() {
    pendingCandidates.length = 0;
    if (!pc) return;
    try { pc.close(); } catch { /* ja fechado */ }
    pc = null;
    if (video.srcObject) video.srcObject = null;
  }

  function armP2PTimeout() {
    clearTimeout(p2pTimer);
    p2pTimer = setTimeout(() => {
      if (!gotMedia && hostOnline && !relayOn) {
        SS.toast('Conexão direta não fechou — usando modo compatibilidade.');
        enableRelay(true);
      }
    }, P2P_TIMEOUT);
  }

  // ----------------------------------------------------- modo relay (WS+MSE)
  function setMode(label) {
    modePill.hidden = false;
    modePill.textContent = label;
    modePill.className = `pill ${label === 'direto' ? 'ok' : 'warn'}`;
    btnRelay.classList.toggle('primary', label !== 'direto');
    btnRelay.textContent = label === 'direto' ? 'Modo compatibilidade' : 'Voltar ao modo direto';
  }

  function enableRelay(on) {
    relayOn = on;
    if (on) {
      closePc();
      gotMedia = false;
      stage.classList.remove('has-video');
      SS.setLive(false);
      conn.send({ t: 'relay-on' });
      setMode('relay');
      SS.setStatus('conectando (relay)…', 'warn');
    } else {
      conn.send({ t: 'relay-off' });
      stopRelayPlayback();
      setMode('direto');
      SS.setStatus('conectando…');
      armP2PTimeout();
    }
  }

  btnRelay.addEventListener('click', () => enableRelay(!relayOn));

  function startRelayPlayback(mime) {
    stopRelayPlayback();
    if (!window.MediaSource || !MediaSource.isTypeSupported(mime)) {
      SS.toast('Seu navegador não suporta o modo compatibilidade.');
      return;
    }

    queue = [];
    mediaSource = new MediaSource();
    video.srcObject = null;
    video.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
      } catch (err) {
        console.warn('addSourceBuffer falhou', err);
        return;
      }
      sourceBuffer.mode = 'sequence';
      sourceBuffer.addEventListener('updateend', () => { trimBuffer(); pump(); });
      pump();
    }, { once: true });
  }

  function stopRelayPlayback() {
    queue = [];
    sourceBuffer = null;
    if (mediaSource) {
      try { if (mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch { /* ok */ }
      if (video.src) URL.revokeObjectURL(video.src);
      mediaSource = null;
    }
    video.removeAttribute('src');
  }

  function onChunk(buf) {
    if (!relayOn) return;
    queue.push(buf);
    // Se o player nao consegue acompanhar, larga o passado e segue o vivo.
    if (queue.length > 80) queue.splice(0, queue.length - 40);
    pump();
  }

  function pump() {
    if (!sourceBuffer || sourceBuffer.updating || !queue.length) return;
    if (!mediaSource || mediaSource.readyState !== 'open') return;
    try {
      sourceBuffer.appendBuffer(queue.shift());
      if (!gotMedia) { setMode('relay'); showVideo(); }
    } catch (err) {
      // QuotaExceeded: limpa o que ja passou e tenta de novo no proximo ciclo.
      if (err && err.name === 'QuotaExceededError') trimBuffer(true);
      else console.warn('append falhou', err);
    }
  }

  function trimBuffer(aggressive = false) {
    if (!sourceBuffer || sourceBuffer.updating) return;
    const buffered = sourceBuffer.buffered;
    if (!buffered.length) return;
    const start = buffered.start(0);
    const end = buffered.end(buffered.length - 1);
    const keep = aggressive ? 4 : 20;
    if (end - start > keep) {
      try { sourceBuffer.remove(start, end - (aggressive ? 2 : 10)); } catch { /* ok */ }
    }
  }

  // Mantem a reproducao colada no vivo (o buffer tende a acumular atraso).
  setInterval(() => {
    if (!relayOn || !video.buffered.length) return;
    const end = video.buffered.end(video.buffered.length - 1);
    if (end - video.currentTime > 1.5) video.currentTime = end - 0.4;
    if (video.paused) video.play().catch(() => {});
  }, 2000);

  // ---------------------------------------------------------------- controles
  btnSound.addEventListener('click', async () => {
    video.muted = !video.muted;
    btnSound.textContent = video.muted ? '🔇 Ativar som' : '🔊 Som ligado';
    btnSound.classList.toggle('primary', video.muted);
    try { await video.play(); } catch { /* ok */ }
  });

  btnFull.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen().catch(() => {});
  });

  video.addEventListener('dblclick', () => btnFull.click());

  btnNick.addEventListener('click', () => {
    const value = nick.value.trim().slice(0, 32);
    localStorage.setItem('ss-nick', value);
    conn.setName(value);
    SS.toast('Apelido salvo — recarregando para aplicar.');
    setTimeout(() => location.reload(), 700);
  });

  setPlaceholder('Aguardando a transmissão…', 'Assim que o host começar a compartilhar, a tela aparece aqui.');
})();
