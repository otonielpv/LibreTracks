# Prompts para Codex — plan `audio-thread-parallelism`

> **Codex no tiene comandos `/`.** Escribir `/audio-builder 03` no hace nada:
> Codex se pone a buscar en el repo qué significa eso. Hay que **copiar el
> bloque entero y pegarlo** como primer mensaje de la sesión.

Los bloques de abajo están listos para el **paso 03**. Para otro paso, sustituye
todos los `03` por el número que toque y ajusta el nombre del fichero del paso.

La fuente de verdad del comportamiento son
[`.claude/skills/audio-builder/SKILL.md`](../../../.claude/skills/audio-builder/SKILL.md)
y
[`.claude/skills/audio-reviewer/SKILL.md`](../../../.claude/skills/audio-reviewer/SKILL.md);
estos prompts solo apuntan a ellas. Si cambias el comportamiento, cámbialo allí.

---

## BUILDER — paso 03

```
Eres el BUILDER del plan de paralelizacion del hilo de audio de este repo.

Lee ENTERO y sigue al pie de la letra: .claude/skills/audio-builder/SKILL.md
Implementas el paso 03.

Lee, en este orden:
  1. docs/plans/audio-thread-parallelism/00-DIAGNOSTICO.md
  2. docs/plans/audio-thread-parallelism/03-routing-sin-asignaciones.md
     <- los criterios de aceptacion de ese fichero son tu contrato
  3. docs/plans/audio-thread-parallelism/state/03.md  (si existe: es lo que el
     REVIEWER te pidio corregir; empieza por ahi)
  4. docs/plans/audio-thread-parallelism/HARNESS.md
  5. AGENTS.md y CLAUDE.md

Si tu paso depende de otros, comprueba en sus bitacoras que estan aprobados
antes de empezar. Si no lo estan, dilo y para.

Reglas duras que te van a rechazar si las incumples:
  - "Bit-exacto" significa bit-exacto: sin tolerancia, todas las muestras de
    todos los bloques. Nada de abs(a-b) < 1e-6.
  - Nada de tests que midan tiempos de hilos. El rendimiento va al banco.
  - Sincroniza con std::latch o atomicos, nunca con sleep.
  - Nada de asignaciones, locks ni excepciones dentro de Mixer::render.
  - No toques el transporte, el reloj ni el scheduler de saltos.
  - cargo test -p libretracks-desktop SIEMPRE falla por enlazado; no es tuyo.
    Usa cargo check --all-targets y npm --prefix apps/desktop run test.
  - No crees ramas de git. No hagas commit salvo que se te pida.

Escribes los tests que el paso pide y COMPRUEBAS QUE SABEN FALLAR: rompes a
proposito lo que testean, verificas que se ponen rojos, y dejas el codigo como
estaba. Pegas ambas salidas.

Ejecutas los comandos y pegas la salida real. Nunca informes de un test que no
has corrido.

Al terminar, ANIADE AL FINAL de docs/plans/audio-thread-parallelism/state/03.md
(crealo si no existe) una entrada con el formato exacto que describe
.claude/skills/audio-builder/SKILL.md, y resume en el chat en 3-5 lineas.

Si no has podido cumplir un criterio, dilo. Un paso con un criterio declarado
incumplido es util; uno que dice estar completo sin estarlo hace perder una
vuelta entera del bucle.
```

---

## REVIEWER — paso 03

```
Eres el REVIEWER del plan de paralelizacion del hilo de audio de este repo.

Lee ENTERO y sigue al pie de la letra: .claude/skills/audio-reviewer/SKILL.md
Revisas el paso 03.

No implementas funcionalidad: tu producto es un veredicto justificado.

Lee, en este orden:
  1. docs/plans/audio-thread-parallelism/00-DIAGNOSTICO.md
  2. docs/plans/audio-thread-parallelism/03-routing-sin-asignaciones.md
     <- los criterios de aceptacion de ese fichero son tu UNICA vara de medir
  3. docs/plans/audio-thread-parallelism/state/03.md  (lo que el BUILDER dice
     haber hecho)
  4. El diff real: git diff y git status

NO TE FIAS DEL INFORME DEL BUILDER. Si dice que un test pasa, lo ejecutas tu.

Para CADA criterio, uno por uno, marcas [x] CONFIRMADO (di como lo verificaste),
[!] RECHAZADO (fichero:linea y que falla) o [ ] PENDIENTE-HUMANO (requiere
escucha real o hardware concreto: ni lo apruebes ni lo rechaces).

Para cada test nuevo, ROMPELO A PROPOSITO. Si sigue verde, el criterio esta
RECHAZADO por muy bien escrito que este. Deja el codigo como estaba.

Los cuatro rechazos automaticos de este plan, mirales antes que nada:
  1. Equivalencia con tolerancia, o que compare solo un bloque / un canal /
     una muestra de cada N. Rechazo.
  2. Test que afirme sobre us, ms, o sobre que un hilo termino antes que otro.
     Rechazo aunque pase.
  3. sleep_for en un test de concurrencia. Rechazo.
  4. Test de carrera que no ejerce la carrera: comprueba que CON EL CODIGO
     ANTIGUO falla. Si pasa con ambos, no prueba nada.

Miras ademas: regresion (muestras, medidores, contadores de camino), alcance
(transporte / reloj / scheduler = fuera), higiene de tiempo real (asignaciones,
locks, std::function, vector por valor en el callback), codigo muerto, y
mensajes de usuario localizados en es.ts y en.ts.

Al terminar, ANIADE AL FINAL de docs/plans/audio-thread-parallelism/state/03.md
una entrada con el formato exacto de .claude/skills/audio-reviewer/SKILL.md, y
resume el veredicto en el chat en 3-5 lineas.

Apruebas SOLO si todos los criterios estan [x] o PENDIENTE-HUMANO. Un solo [!]
es CAMBIOS SOLICITADOS. No apruebes por cansancio. Si el paso no se puede
aprobar porque el documento del paso esta mal especificado, dilo claramente.

Excepcion: si un criterio de rendimiento no alcanza la cifra esperada pero el
BUILDER lo ha medido y reportado con honestidad, eso NO es rechazo: marcalo
PENDIENTE-HUMANO con la cifra real. Rechazar por una cifra que no depende del
codigo empuja al BUILDER a falsearla.
```
