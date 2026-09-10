# Share Screen

> Apos o discord banir o compartilhamento de tela no Brasil montei esse projeto

Compartilhamento de tela estilo Discord, rodando na sua máquina. Você inicia o
servidor, ele cria um túnel público para o seu localhost e devolve um link.
Quem receber o link vê sua tela (e ouve o áudio) direto no navegador — sem
instalar nada, sem conta, sem servidor na nuvem.

```
você  ──captura a tela──►  seu PC (servidor local)
                                │
                                ├── túnel Cloudflare ──► https://algo.trycloudflare.com/j/TOKEN
                                │
convidado ◄── vídeo WebRTC direto (P2P) ──────────────────────┘
```

O vídeo trafega **direto entre os dois computadores** por WebRTC. O túnel só
carrega a página e a negociação da conexão — por isso a qualidade não fica
limitada pelo túnel.

## Como usar

```bash
npm install
npm start
```

O terminal mostra dois links:

```
Seu painel (host):  http://localhost:8787/h/xxxxxxxx
Link p/ convidados: https://algo-qualquer.trycloudflare.com/j/yyyyyyyy
```

1. O painel abre sozinho no navegador.
2. Clique em **Compartilhar tela** e escolha a tela, a janela ou a aba.
   Para mandar o áudio junto, marque **"Compartilhar áudio"** na janela do Chrome/Edge.
3. Mande o **link p/ convidados** para quem vai assistir.
4. `Ctrl+C` no terminal encerra tudo e fecha o túnel.

Na primeira execução o `cloudflared` (~40 MB) é baixado automaticamente para
`~/.share-screen/`. Depois disso a inicialização é instantânea.

No Windows, `start.bat` faz o `npm install` (se preciso) e sobe o servidor com
um clique duplo.

## O que dá para fazer

| Recurso | Onde |
|---|---|
| Tela, janela ou aba + áudio do sistema | painel do host |
| Microfone (falar com quem assiste) | botão 🎤 no painel |
| Resolução, FPS e banda ajustáveis ao vivo | barra lateral do host |
| Nitidez (código/texto) × fluidez (vídeo/jogo) | barra lateral do host |
| Vários espectadores ao mesmo tempo | automático |
| Remover um espectador | botão ✕ na lista |
| Chat de texto | barra lateral dos dois lados |
| Tela cheia, som on/off, apelido | página do convidado |
| Bitrate/FPS reais da transmissão | canto superior do painel |

## Modo compatibilidade

Algumas redes (corporativas, alguns 4G/5G, VPNs) bloqueiam a conexão direta
entre os dois computadores. Quando isso acontece, o espectador cai
automaticamente para o **modo compatibilidade** depois de ~12 segundos: o vídeo
passa a ser transcodificado e repassado pelo próprio túnel.

Funciona em qualquer rede, ao custo de ~1 segundo de atraso e um pouco de CPU
na sua máquina. O botão **Modo compatibilidade**, na página do convidado,
alterna manualmente entre os dois caminhos.

Se você tiver um servidor TURN próprio, adicione-o em `iceServers`
(em [public/js/common.js](public/js/common.js#L11-L20)) — assim quase todo mundo
fica no caminho direto, sem passar pelo relay.

## Segurança

- Cada execução gera **dois tokens aleatórios novos**: um para o seu painel,
  outro para os convidados. Reiniciar o servidor invalida os links antigos.
- O token do convidado só dá acesso a assistir; ele não abre o painel nem
  permite transmitir.
- Quem tiver o link entra na sala — trate-o como uma senha e não publique.
- Encerrar o processo derruba o túnel: a URL deixa de existir.

## Opções de linha de comando

```bash
node server.js --port=9000        # muda a porta local
node server.js --no-tunnel        # só rede local, sem expor na internet
node server.js --tunnel=localtunnel   # usa localtunnel em vez do cloudflared
node server.js --no-open          # não abre o navegador sozinho
```

Sem túnel, o link de convidado funciona só na sua máquina. Para usar na rede
local (mesmo Wi-Fi), troque `localhost` pelo IP do seu PC — mas note que
navegadores exigem HTTPS para WebRTC fora do localhost, então nesse cenário os
convidados caem no modo compatibilidade.

## Requisitos

- Node.js 18 ou mais novo.
- Chrome, Edge ou outro navegador baseado em Chromium para **transmitir**
  (é o que suporta captura de tela com áudio). Para **assistir**, qualquer
  navegador moderno serve, Firefox e Safari incluídos.

## Como está organizado

```
server.js              servidor HTTP + WebSocket, tokens e sinalização
lib/tunnel.js          baixa/sobe o cloudflared, com fallback para localtunnel
public/host.html/js    captura a tela e mantém uma conexão WebRTC por espectador
public/viewer.html/js  recebe o vídeo (WebRTC ou, se preciso, pelo relay)
public/js/common.js    WebSocket com reconexão, chat, avisos e config de ICE
```

Licença MIT.
