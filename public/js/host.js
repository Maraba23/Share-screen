/* Painel do host: captura a tela e serve cada espectador por WebRTC,
   com um caminho alternativo (MediaRecorder -> WebSocket) para quem nao
   consegue fechar conexao direta. */
'use strict';

(() => {
  const { el, ICE } = SS;

  const stage = el('stage');
  const preview = el('preview');
  const btnShare = el('btnShare');
  const btnStop = el('btnStop');
  const btnMic = el('btnMic');
  const btnCopy = el('btnCopy');
  const viewUrl = el('viewUrl');
  const linkHint = el('linkHint');
  const peopleList = el('people');
  const peopleEmpty = el('peopleEmpty');
  const countEl = el('count');
  const statsPill = el('statsPill');
  const selRes = el('selRes');
  const selFps = el('selFps');
  const selRate = el('selRate');
  const rateLabel = el('rateLabel');
  const selMode = el('selMode');

  const RELAY_MIMES = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  const peers = new Map();    // viewerId -> { pc, videoSender, audioSender }
  const viewers = new Map();  // viewerId -> { name, mode }

  let stream = null;          // stream enviado (video da tela + audio mixado)
  let screenStream = null;    // captura crua do getDisplayMedia
  let audioCtx = null;
  let audioDest = null;
  let micStream = null;
  let micNode = null;
  let recorder = null;
  let relayWanted = false;

  // ------------------------------------------------------------- sinalizacao
  const conn = SS.connect({
    name: 'Host',
    onJson: handleMessage,
    onOpen: () => {
      SS.setStatus(stream ? 'transmitindo' : 'pronto', stream ? 'ok' : '');
      if (stream) for (const id of viewers.keys()) startPeer(id);
    },
    onClose: (ev) => {
      if (ev.code === 4000) {
        SS.setStatus('outra aba assumiu', 'bad');
        SS.toast('Você abriu o painel em outra aba; esta ficou inativa.');
      } else {
        SS.setStatus('reconectando…', 'warn');
      }
    },
  });

  const chat = SS.setupChat({ conn, me: 'Você' });

  function handleMessage(msg) {
    switch (msg.t) {
      case 'joined':
        SS.setStatus('pronto');
        break;
      case 'viewer-join':
        viewers.set(msg.id, { name: msg.name, mode: 'p2p' });
        chat.system(`${msg.name} entrou.`);
        if (stream) startPeer(msg.id);
        break;
      case 'viewer-left': {
        const gone = viewers.get(msg.id);
        if (gone) chat.system(`${gone.name} saiu.`);
        viewers.delete(msg.id);
        closePeer(msg.id);
        break;
      }
      case 'viewers': {
        const ids = new Set(msg.list.map((v) => v.id));
        for (const v of msg.list) {
          const prev = viewers.get(v.id) || {};
          viewers.set(v.id, { ...prev, name: v.name, mode: v.mode });
          if (v.mode === 'relay') closePeer(v.id);
          else if (stream && !peers.has(v.id)) startPeer(v.id);
        }
        for (const id of [...viewers.keys()]) {
          if (!ids.has(id)) { viewers.delete(id); closePeer(id); }
        }
        renderPeople();
        break;
      }
      case 'viewer-p2p': {
        const v = viewers.get(msg.id);
        if (v) v.mode = 'p2p';
        if (stream) startPeer(msg.id);
        break;
      }
      case 'signal':
        onSignal(msg.from, msg.data);
        break;
      case 'relay-need':
        relayWanted = true;
        startRecorder();
        break;
      case 'relay-stop':
        relayWanted = false;
        stopRecorder();
        break;
      case 'chat':
        chat.line(msg.name, msg.text);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------- WebRTC P2P
  function startPeer(id) {
    closePeer(id);
    if (!stream) return;

    const pc = new RTCPeerConnection(ICE);
    // `chain` serializa a aplicacao dos sinais e `pending` guarda candidatos
    // que chegam antes da descricao remota (senao seriam descartados).
    const entry = { pc, videoSender: null, audioSender: null, chain: Promise.resolve(), pending: [] };
    peers.set(id, entry);

    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      if (track.kind === 'video') entry.videoSender = sender;
      else entry.audioSender = sender;
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) conn.send({ t: 'signal', to: id, data: { candidate: ev.candidate } });
    };
    pc.onconnectionstatechange = () => {
      const v = viewers.get(id);
      if (v) {
        v.state = pc.connectionState;
        renderPeople();
      }
      if (pc.connectionState === 'failed') pc.restartIce();
    };

    applyQualityToPeer(entry);
    negotiate(id, entry);
  }

  async function negotiate(id, entry) {
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      conn.send({ t: 'signal', to: id, data: { sdp: entry.pc.localDescription } });
    } catch (err) {
      console.warn('falha ao negociar com', id, err);
    }
  }

  function onSignal(id, data) {
    const entry = peers.get(id);
    if (!entry) return;
    entry.chain = entry.chain.then(async () => {
      if (peers.get(id) !== entry) return; // peer trocado no meio do caminho
      try {
        if (data.sdp) {
          await entry.pc.setRemoteDescription(data.sdp);
          for (const c of entry.pending.splice(0)) {
            await entry.pc.addIceCandidate(c).catch(() => {});
          }
        } else if (data.candidate) {
          if (!entry.pc.remoteDescription) entry.pending.push(data.candidate);
          else await entry.pc.addIceCandidate(data.candidate);
        }
      } catch (err) {
        console.warn('sinal ignorado', err);
      }
    });
  }

  function closePeer(id) {
    const entry = peers.get(id);
    if (!entry) return;
    entry.pending.length = 0;
    try { entry.pc.close(); } catch { /* ja fechado */ }
    peers.delete(id);
  }

  // -------------------------------------------------------------- qualidade
  const targetBitrate = () => Number(selRate.value) * 1_000_000;

  function applyQualityToPeer(entry) {
    if (!entry.videoSender) return;
    const params = entry.videoSender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = targetBitrate();
    params.degradationPreference = selMode.value === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
    entry.videoSender.setParameters(params).catch(() => { /* nem todo browser aceita */ });
  }

  async function applyQuality() {
    rateLabel.textContent = `${selRate.value} Mbps`;
    for (const entry of peers.values()) applyQualityToPeer(entry);

    const track = stream && stream.getVideoTracks()[0];
    if (!track) return;

    track.contentHint = selMode.value === 'detail' ? 'detail' : 'motion';

    const height = Number(selRes.value);
    const fps = Number(selFps.value);
    const constraints = { frameRate: { max: fps } };
    if (height) {
      constraints.height = { max: height };
      constraints.width = { max: Math.round((height * 16) / 9) };
    }
    try { await track.applyConstraints(constraints); } catch { /* a captura pode recusar */ }
  }

  [selRes, selFps, selMode].forEach((node) => node.addEventListener('change', applyQuality));
  selRate.addEventListener('input', () => { rateLabel.textContent = `${selRate.value} Mbps`; });
  selRate.addEventListener('change', applyQuality);

  // ------------------------------------------------------------- audio (mix)
  // Mixa audio do sistema + microfone numa unica track, para que ligar/desligar
  // o microfone nao exija renegociar a conexao.
  function buildAudio(systemTrack) {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioDest = audioCtx.createMediaStreamDestination();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (systemTrack) {
      const src = audioCtx.createMediaStreamSource(new MediaStream([systemTrack]));
      src.connect(audioDest);
    }
    if (micNode) micNode.connect(audioDest);
    return audioDest.stream.getAudioTracks()[0];
  }

  async function toggleMic() {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      if (micNode) { try { micNode.disconnect(); } catch { /* ja solto */ } }
      micStream = null;
      micNode = null;
      btnMic.textContent = '🎤 Microfone';
      btnMic.classList.remove('primary');
      SS.toast('Microfone desligado.');
      return;
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      SS.toast('Não consegui acessar o microfone.');
      return;
    }
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioDest = audioCtx.createMediaStreamDestination();
    }
    micNode = audioCtx.createMediaStreamSource(micStream);
    if (stream) micNode.connect(audioDest);
    btnMic.textContent = '🎤 Microfone ligado';
    btnMic.classList.add('primary');
    SS.toast('Microfone ligado.');
  }

  btnMic.addEventListener('click', toggleMic);

  // ---------------------------------------------------------------- captura
  async function startShare() {
    const height = Number(selRes.value);
    const video = { frameRate: { ideal: Number(selFps.value) } };
    if (height) {
      video.height = { ideal: height, max: height };
      video.width = { ideal: Math.round((height * 16) / 9) };
    }

    let captured;
    try {
      captured = await navigator.mediaDevices.getDisplayMedia({
        video,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') SS.toast(`Falha ao capturar: ${err.message}`);
      return;
    }

    const first = !stream;
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    screenStream = captured;

    const videoTrack = captured.getVideoTracks()[0];
    const audioTrack = buildAudio(captured.getAudioTracks()[0]);

    videoTrack.addEventListener('ended', stopShare);

    stream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
    preview.srcObject = stream;
    stage.classList.add('has-video');
    btnShare.textContent = 'Trocar tela';
    btnStop.hidden = false;
    statsPill.hidden = false;
    SS.setLive(true);
    SS.setStatus('transmitindo', 'ok');
    await applyQuality();

    if (first) {
      for (const id of viewers.keys()) startPeer(id);
    } else {
      // Troca de origem sem derrubar as conexoes ja abertas.
      for (const entry of peers.values()) {
        if (entry.videoSender) entry.videoSender.replaceTrack(videoTrack).catch(() => {});
        if (entry.audioSender && audioTrack) entry.audioSender.replaceTrack(audioTrack).catch(() => {});
        applyQualityToPeer(entry);
      }
    }
    if (relayWanted) startRecorder();
  }

  function stopShare() {
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    stopRecorder();
    for (const id of [...peers.keys()]) closePeer(id);
    screenStream = null;
    stream = null;
    preview.srcObject = null;
    stage.classList.remove('has-video');
    btnShare.textContent = 'Compartilhar tela';
    btnStop.hidden = true;
    statsPill.hidden = true;
    SS.setLive(false);
    SS.setStatus('pronto');
    conn.send({ t: 'idle' });
  }

  btnShare.addEventListener('click', startShare);
  btnStop.addEventListener('click', stopShare);

  // ------------------------------------------- caminho alternativo (relay)
  function pickMime() {
    return RELAY_MIMES.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  function startRecorder() {
    if (!stream) return;
    stopRecorder();

    const mimeType = pickMime();
    if (!mimeType) {
      SS.toast('Este navegador não suporta o modo compatibilidade.');
      return;
    }

    // O servidor so repassa os binarios depois deste aviso, que marca a nova
    // geracao do fluxo (cabecalho WebM + keyframe).
    conn.send({ t: 'relay-start', mime: mimeType });

    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: Math.min(targetBitrate(), 2_500_000),
      audioBitsPerSecond: 96_000,
    });
    recorder.ondataavailable = async (ev) => {
      if (!ev.data || !ev.data.size) return;
      // Se o socket ja esta congestionado, descarta em vez de acumular atraso.
      if (conn.bufferedAmount > 6 * 1024 * 1024) return;
      conn.sendBinary(await ev.data.arrayBuffer());
    };
    recorder.onerror = () => stopRecorder();
    recorder.start(250);
  }

  function stopRecorder() {
    if (!recorder) return;
    const r = recorder;
    recorder = null;
    r.ondataavailable = null;
    try { if (r.state !== 'inactive') r.stop(); } catch { /* ja parado */ }
    conn.send({ t: 'relay-stopped' });
  }

  // ------------------------------------------------------------------- gente
  function renderPeople() {
    countEl.textContent = String(viewers.size);
    peopleEmpty.hidden = viewers.size > 0;
    peopleList.textContent = '';

    for (const [id, v] of viewers) {
      const li = document.createElement('li');

      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = v.name;

      const tag = document.createElement('span');
      const relay = v.mode === 'relay';
      tag.className = `tag ${relay ? 'relay' : 'p2p'}`;
      tag.textContent = relay ? 'relay' : (v.state === 'connected' ? 'direto' : (v.state || 'conectando'));

      const kick = document.createElement('button');
      kick.className = 'small ghost';
      kick.textContent = '✕';
      kick.title = 'Remover';
      kick.addEventListener('click', () => conn.send({ t: 'kick', id }));

      li.append(who, tag, kick);
      peopleList.appendChild(li);
    }
  }

  // ------------------------------------------------------------------- stats
  setInterval(async () => {
    if (!stream || !peers.size) return;
    const entry = [...peers.values()].find((e) => e.pc.connectionState === 'connected');
    if (!entry || !entry.videoSender) { statsPill.textContent = 'aguardando conexão'; return; }

    const stats = await entry.videoSender.getStats();
    let out = null;
    stats.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') out = r; });
    if (!out) return;

    const now = out.bytesSent;
    const ts = out.timestamp;
    if (statsPill._prev && ts > statsPill._prevTs) {
      const bps = ((now - statsPill._prev) * 8) / ((ts - statsPill._prevTs) / 1000);
      const size = out.frameWidth ? `${out.frameWidth}×${out.frameHeight}` : '';
      const fps = out.framesPerSecond ? `${Math.round(out.framesPerSecond)} fps` : '';
      statsPill.textContent = [size, fps, SS.fmtBits(bps)].filter(Boolean).join(' · ');
    }
    statsPill._prev = now;
    statsPill._prevTs = ts;
  }, 2000);

  // -------------------------------------------------------------------- link
  fetch(`/api/session?k=${encodeURIComponent(SS.token)}`)
    .then((r) => r.json())
    .then((info) => {
      viewUrl.value = info.viewUrl;
      linkHint.textContent = info.tunnel
        ? 'Link público: funciona para qualquer pessoa, em qualquer rede.'
        : 'Túnel indisponível — este link só funciona nesta máquina/rede local.';
    })
    .catch(() => { viewUrl.value = 'erro ao obter o link'; });

  btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(viewUrl.value);
      SS.toast('Link copiado!');
    } catch {
      viewUrl.select();
      SS.toast('Copie com Ctrl+C.');
    }
  });

  window.addEventListener('beforeunload', () => {
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
  });
})();
