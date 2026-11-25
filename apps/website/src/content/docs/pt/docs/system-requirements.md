---
title: Requisitos do sistema
description: Hardware mínimo e recomendado, sistemas operacionais e configuração de áudio ao vivo para rodar o LibreTracks.
---

O LibreTracks é um app nativo leve (Rust + Tauri), não uma DAW de estúdio pesada, então roda bem em máquinas modestas. Os números abaixo são orientações práticas, não limites rígidos: o verdadeiro gargalo no palco é o tom/warp em tempo real, que cresce com quantas faixas você transpõe ao mesmo tempo.

## Sistemas operacionais

| Plataforma | Mínimo | Observações |
| --- | --- | --- |
| **Windows** | Windows 10 (64 bits) | Precisa do runtime **WebView2**, que já vem instalado no Windows 10/11 atual. |
| **macOS** | macOS 12 **Monterey** | Intel e Apple Silicon (app universal). |
| **Linux** | Ubuntu 22.04 / Fedora 36 ou mais recente | Requer `webkit2gtk-4.1`, `gtk3` e ALSA. Distribuído como `.deb`, `.rpm` e `.AppImage`. |

O AppImage usa o WebKitGTK, o GTK e o Mesa do sistema, assim como os pacotes
`.deb` e `.rpm`. Isso evita misturar drivers gráficos atuais com bibliotecas
antigas empacotadas e melhora a compatibilidade com Wayland no Bazzite, Arch e Fedora.

> **Por que macOS 12?** O motor de tom e warp (Bungee) e a forma como o áudio é distribuído entre os núcleos da CPU precisam de recursos do sistema que chegaram com o macOS 11 e 12. Em versões mais antigas o app não abre.

## iPhone e iPad

O LibreTracks está na **App Store** para iPhone e iPad com **iOS / iPadOS 15
ou mais recente**. Ele roda na horizontal. O que muda em relação ao computador
está em [No celular ou tablet](/pt/docs/interface/mobile/).

## Android

O suporte a Android é mais novo que as versões para computador, e os celulares
são onde os limites aparecem primeiro, normalmente no armazenamento e na
paciência, não na memória. Para o que funciona diferente no celular (salvar
sessões num cartão SD ou pendrive, gestos de toque, saída de áudio), veja
[LibreTracks no celular](/pt/docs/mobile/).

| | Mínimo | Confortável | Observações |
| --- | --- | --- | --- |
| **Android** | 7.0 (API 24) | 10 ou mais recente | ARM de 64 bits (`arm64-v8a`); instalado pelo Google Play |
| **RAM** | 2 GB | 3 GB+ | O LibreTracks dimensiona os buffers para o aparelho |
| **Espaço livre** | 2x o tamanho da sessão | 3x | Importar descompacta a sessão e prepara o áudio |

A reprodução lê do armazenamento em vez de carregar as músicas na memória, então
o número de faixas é limitado muito mais pela velocidade com que o celular lê e
decodifica do que pela RAM. Um celular de 2,5 GB toca uma sessão de 36 faixas; o
que ele não consegue é importá-la rápido.

### Espaço durante a importação

Importar um `.ltset` precisa de espaço para mais do que o próprio arquivo: o
pacote é descompactado e o áudio é preparado para tocar. Conte com cerca de
**o dobro do tamanho do pacote** e deixe um gigabyte sobrando. Um repertório de
2 GB pede uns 5 GB livres.

O LibreTracks recusa uma importação que claramente não vai caber, em vez de
encher o aparelho e falhar no meio.

### Fazer uma sessão grande carregar mais rápido

Importar um repertório grande num celular modesto leva minutos, e isso é a
velocidade do armazenamento, não um bug. Para reduzir, exporte do computador de
uma forma mais leve:

- A exportação **Optimized** leva o áudio já preparado para tocar, então o
  celular pula a decodificação inteira: a sessão abre sem etapa de preparação e
  não grava nada no cache de áudio. O pacote é maior para transferir e não muda
  quantas faixas tocam ao mesmo tempo; muda quanto tempo você espera.
- A exportação **Light** deixa o áudio de fora, para quando os arquivos já
  estão no aparelho.
- **Dividir um repertório em músicas mais curtas** mantém cada importação
  pequena, que é a opção mais confiável num celular antigo.

## Formatos de áudio

O motor de áudio traz o FFmpeg nas **três plataformas**, então os mesmos formatos abrem em todas: WAV, AIFF, FLAC, MP3 e AAC/M4A, entre outros. Não há codec para instalar à parte: no macOS as bibliotecas de codec vão dentro do `.app`, e no Windows e no Linux vêm junto com o app.

## Hardware

| | Mínimo | Recomendado |
| --- | --- | --- |
| **CPU** | Dual-core moderno de 64 bits | Quad-core ou melhor, necessário para várias faixas com tom/warp ao mesmo tempo |
| **RAM** | 4 GB | 8 GB+ |
| **Armazenamento** | Espaço para o seu áudio e o cache | SSD. Além dos seus arquivos de áudio (tocados de onde estiverem), cada sessão guarda um cache de formas de onda e áudio preparado |
| **Tela** | 1280×800 | 1440×900 ou maior |

O tom e o warp em tempo real são a parte mais pesada do app. Uma única faixa transposta é leve; o que se beneficia de uma CPU mais rápida é rodar muitas faixas transpostas ao mesmo tempo. Num quad-core moderno típico você mantém nove ou mais vozes transpostas simultâneas dentro do orçamento de áudio.

## Vídeo

Para projetar [vídeo](/pt/docs/tasks/video/) você precisa de uma **segunda tela**
(projetor, TV ou monitor) conectada ao computador; com uma tela só, o vídeo
pode ser mostrado numa janela.

- **Windows e macOS**: o player de vídeo (libmpv) vem dentro do app.
- **Linux**: se **Settings → Video** disser "Video unavailable", instale a
  biblioteca mpv da sua distribuição (`libmpv2` no Debian/Ubuntu, `mpv-libs` no
  Fedora).
- A decodificação por hardware usa a placa de vídeo; um vídeo 1080p H.264 roda
  bem em qualquer máquina atual.
- No **celular**, você precisa de saída de vídeo por cabo: USB-C para HDMI
  (DisplayPort sobre USB-C no Android) ou o adaptador Lightning Digital AV.

## Remote e nuvem

- O [Remote](/pt/docs/remote-control/) roda no **navegador** de qualquer celular ou
  tablet atual (Chrome, Safari, Firefox, Edge), sem instalar nada. O
  computador e o aparelho precisam estar na **mesma rede**.
- A [nuvem](/pt/docs/integration-ecosystem/#a-nuvem-google-drive-onedrive-e-dropbox) precisa de
  uma **conta Google** (grátis) e de internet enquanto envia ou baixa. O espaço
  é o do seu Google Drive.

## Configuração de áudio ao vivo

Para ensaiar você pode usar a saída interna, mas **para o palco uma interface de áudio dedicada é muito recomendada**:

- **Windows**: um driver **ASIO** dá a latência mais baixa e estável e expõe todos os canais do hardware (dois numa interface estéreo, oito numa MOTU, trinta e dois numa X32 por USB).
- **macOS**: **Core Audio** com uma interface class-compliant ou do fabricante.
- **Tamanho do buffer**: buffers menores reduzem a latência, mas custam CPU. Encontre o menor buffer que roda sem falhas na sua máquina.

A transposição em tempo real adiciona uma latência inerente (cerca de 108 ms com o motor atual), então, quando o tempo é crítico, prefira material já processado com warp/tom em vez da transposição ao vivo, sempre que puder.

Veja [Saídas de áudio e metrônomo](/pt/docs/audio-routing-metronome/) para saber como ativar saídas físicas e o fluxo de Apply/Discard dos canais.
