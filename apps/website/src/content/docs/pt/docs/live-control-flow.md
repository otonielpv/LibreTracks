---
title: Controle ao vivo
description: "Como se mover pelo repertório ao vivo com o LibreTracks: saltos para marcadores e músicas, quando eles acontecem, Vamp, transições, atalhos de teclado, pedal MIDI e o Remote."
---

Ao vivo, quase tudo se resume a três perguntas: **para onde** você salta,
**quando** o salto acontece e **como** a mudança soa. O LibreTracks responde às
três do mesmo jeito pelo teclado, pela [Live View](/pt/docs/live-view/), por um
pedal MIDI ou pelo [Remote](/pt/docs/remote-control/): todos agendam o mesmo salto.

## Saltar para um marcador

Um clique num marcador de seção (ou na tecla numérica dele) **agenda** o salto.
O ajuste *Marker Jump* da barra de ferramentas decide quando ele acontece:

![Os ajustes de salto para marcador](/guide/desktop-en/toolbar-marker-jump-panel.png)

- **Immediate**: na hora.
- **After X bars**: depois de passarem os compassos que você definir.
- **At next marker**: quando chega a próxima seção, para a mudança cair no
  início de uma frase.

Enquanto ele espera, **Cancel jump** acende; <kbd>Esc</kbd> ou um clique no
mesmo marcador o cancela. Com a [guia falada](/pt/docs/voice-guide/) ligada, a banda
ouve a seção de destino e a contagem de entrada antes do salto.

## Vamp: repetir até chegar a hora

O **Vamp** repete um trecho em loop enquanto a banda estica um final, alguém
fala ou é preciso mais tempo. Escolha o que se repete:

![Os ajustes do Vamp](/guide/desktop-en/toolbar-vamp-panel.png)

- **Section**: a seção em que o cursor está.
- **Bars**: o número de compassos que você definir.

Aperte **Vamp** de novo para sair; a música segue dali.

## Passar para outra música

Os botões **Previous** e **Next**, <kbd>Shift</kbd>+número, a Live View ou o
Remote saltam entre as músicas. *Song Transition* decide quando e como:

![Os ajustes de transição entre músicas](/guide/desktop-en/toolbar-song-jump-panel.png)

- **Quando**: na hora, no fim da música, depois de alguns compassos ou no
  próximo marcador.
- **Como**: **Clean cut** ou **Fade out** da música que está tocando.

Se você preferir que a reprodução pare entre as músicas, ligue *Pause at the
end of each song* em Settings › General › Playback.

## Atalhos de teclado

Todos podem ser mudados em **Settings › Shortcuts** (veja
[Configurações](/pt/docs/interface/settings/#shortcuts)). Os padrões:

| Tecla | Ação |
| --- | --- |
| <kbd>Espaço</kbd> | Play / pausa |
| <kbd>Shift</kbd>+<kbd>Espaço</kbd> | Stop (volta ao início) |
| <kbd>Home</kbd> | Ir para o início |
| <kbd>0</kbd> … <kbd>9</kbd> | Saltar para o 1º … 10º marcador da sessão, em ordem de tempo e contando também os cues (a mesma tecla de novo cancela) |
| <kbd>Shift</kbd>+<kbd>0</kbd> … <kbd>9</kbd> | Saltar para a música nº 1 … 10 |
| <kbd>Esc</kbd> | Cancelar um salto pendente ou limpar a seleção |
| <kbd>S</kbd> | Dividir os clipes selecionados no cursor |
| <kbd>Shift</kbd>+<kbd>S</kbd> | Dividir a música no cursor |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> | Copiar / colar clipes |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicar |
| <kbd>Del</kbd> ou <kbd>Backspace</kbd> | Apagar a seleção (clipes, faixas ou música) |
| <kbd>F2</kbd> | Renomear a música, faixa ou marcador selecionado |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Desfazer |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> ou <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Refazer |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Selecionar todos os clipes |
| <kbd>←</kbd> / <kbd>→</kbd> | Empurrar os clipes selecionados uma divisão |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Salvar / salvar como |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Trocar de visão: DAW, Compact, Live (e de volta) |
| <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> | Aumentar, diminuir ou redefinir a interface |
| <kbd>B</kbd> | Vídeo: preto instantâneo |

**Fade out and stop** (abaixa a música e para; veja
[Fade out and stop](/pt/docs/interface/main-screen/#fade-out-and-stop)) e as ações
de vídeo *fade to black*, *idle screen* e *turn output on* não têm tecla
padrão, para não dispararem sem querer no palco; atribua você mesmo se for
usá-las.

Se agendar o salto errado, aperte <kbd>Esc</kbd> na hora.

## Com um pedal MIDI

Qualquer ação desta página pode ser atribuída a um pedal ou a um botão do seu
controlador: saltar para o marcador 3, próxima música, Vamp, cancelar salto…
Veja [MIDI](/pt/docs/tasks/midi/).

## Pelo celular: o Remote

Abra **Remote** na barra lateral, escaneie o QR code com o celular ou tablet
(mesmo Wi-Fi) e a banda tem transporte, saltos, Vamp, tom e a mixagem nas mãos.
Veja [Remote personalizado](/pt/docs/remote-control/).

## Mudar o tom ao vivo

Faça as mudanças de tom **antes de apertar Play** ou entre as músicas: mudá-lo
enquanto toca faz o motor reorganizar as vozes e, em computadores modestos,
pode causar pequenas falhas. Como o tom, o warp e o botão **T** se combinam está
em [Tom, warp e o botão T](/pt/docs/pitch-and-warp/).
