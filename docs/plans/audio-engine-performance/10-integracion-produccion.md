# El audio preparado: construido, medido y retirado

Etapa del 2026-09-09. **El código que describe este documento ya no existe en el
repositorio.** Se construyó entero, se midió, y se eliminó el mismo día. Esto es
el registro de por qué, para que nadie lo reconstruya sin datos nuevos.

## Qué era

Renderizar warp y tono a un archivo, una sola vez y fuera del hilo de audio,
para que la reproducción leyera el archivo en vez de ejecutar el estirador. El
Freeze de Ableton, básicamente.

Se llegó a construir de punta a punta —siete piezas, 51 tests, cada una
verificada rompiéndola a propósito para comprobar que sus tests sabían fallar—
en los commits `5b3b838c`, `69574b05`, `8ba99e6e`, `8377fc12`, `e98a6d46`,
`93453b9c` y `b0b2907e`. El historial las guarda; recuperarlas es un `git
revert`.

## Por qué se retiró

**El problema que resolvía ya no existe.** Medido en la aplicación real, no en
el banco: **27 pistas con warp Y tono a la vez**, WASAPI, buffer 512,
multinúcleo activado, dan **CPU ~10 % y audio ~14 %**. El presupuesto de un
bloque de 512 a 48 kHz son 10,67 ms, así que son ~1,5 ms usados y unas siete
veces de margen — con una sesión más cargada que los multitracks pesados
habituales.

Lo que resolvió el problema fue **el multihilo**, que ya estaba hecho antes de
empezar esta etapa. Todo lo posterior era un seguro contra una máquina más
lenta.

Y esa máquina, cuando se miró de cerca, no encajaba: el candidato era el Oppo
CPH1931 de `docs/plans/android-low-end/`, con 2 GB de RAM, que **ya no podía con
una canción normal de 15–20 pistas**. Escribirle 0,51 GiB por canción y entre 8
y 15 minutos de preparación no arregla eso; su problema es otro y más básico.

## Por qué no se dejó dormido

Se consideró. Se descartó porque una función que nadie usa se pudre igual que un
test que nadie ejecuta, y porque mantenerla obligaba a arrastrar un campo
(`prepared_render`) por los tres parsers de pista del motor, con el riesgo
permanente de que un futuro cuarto parser lo olvidara y warpease dos veces.

## Qué se conservó, y por qué

- **El banco de fidelidad de saltos** (`bench_fidelity_jump`,
  `scripts/audio-perf/`). Mide si un salto con warp aterriza donde debe
  —desfase 0,00 ms contra el render continuo— y eso es una propiedad del
  **motor que se envía**, no de la función retirada. No existía antes. Ver
  [etapa 07](07-fidelidad-saltos.md).
- **`disk_space.rs`**, que sacó `free_space_bytes` de `session_package` a un
  módulo propio. Es una deduplicación buena por sí sola.
- **Las medidas y los informes** de las etapas 02–09. Son el registro de qué se
  probó y qué salió.

## Lo que este episodio enseña, y es lo más útil que deja

**El orden estaba mal.** La medida que decidió todo —27 pistas en la aplicación
real— costó treinta segundos y llegó la última, después de nueve etapas de banco
y siete fases de implementación. La pregunta *«¿el problema sigue existiendo a
esta escala?»* se podía hacer el primer día.

El plan heredado asumía el problema abierto porque un usuario había reportado
96 % de CPU. Eso era cierto **antes del multihilo**. Nadie volvió a comprobar la
premisa después de arreglarlo.

Corolario para la próxima vez: antes de optimizar, medir que el problema existe
**en la aplicación**, en la máquina que lo tenía, con la configuración real. Un
banco puede confirmar una hipótesis durante semanas sin que nadie note que la
hipótesis caducó.

## Si alguna vez vuelve

Haría falta un dato nuevo: un equipo donde la reproducción con warp sufra **y**
que pueda permitirse preparar. Las dos condiciones, no una.

Y dos decisiones ya tomadas que seguirían valiendo:

- **Nada manual.** Un botón por canción no lo usaría nadie; el referente
  correcto es el prime de waveforms de esta misma app —automático, en segundo
  plano, invisible— y no el Freeze de Ableton, que es manual porque allí
  congelas una pista concreta con un plugin que tú elegiste poner.
- **PCM16, con el recorte vigilado.** El formato ya está decidido y medido en la
  [etapa 08](08-presupuesto-y-formato.md): el ruido queda 80 dB por debajo del
  programa, pero el warp sube 3,3 dB de pico y un stem caliente tocaría el techo.
