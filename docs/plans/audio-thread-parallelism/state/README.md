# Bitácoras de los pasos

Un fichero por paso: `01.md`, `02.md`… Los crean y **amplían** (nunca
sobrescriben) los agentes BUILDER y REVIEWER del plan
`audio-thread-parallelism`.

Este es el único canal de memoria entre invocaciones: cada agente arranca en
frío y lee aquí qué pasó en la vuelta anterior.

Formato de las entradas: ver [`../HARNESS.md`](../HARNESS.md).

> No confundir con `docs/plans/android-low-end/state/`, que es de otro plan y
> lo escriben `/builder` y `/reviewer` (sin prefijo).
