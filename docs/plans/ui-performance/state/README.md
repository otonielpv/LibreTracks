# Bitácoras de los pasos

Un fichero por paso: `01.md`, `02.md`… Los crean y **amplían** (nunca
sobrescriben) los agentes BUILDER y REVIEWER.

Este es el único canal de memoria entre invocaciones: cada agente arranca en
frío y lee aquí qué pasó en la vuelta anterior.

Formato de las entradas: ver
[`../../android-low-end/HARNESS.md`](../../android-low-end/HARNESS.md) (el
mismo bucle BUILDER/REVIEWER; sólo cambia el plan al que apunta).

**Regla propia de este plan:** una entrada sin **cifras de un build de release,
antes y después** no cierra un paso. Ver la regla 1 del
[`README.md`](../README.md).
