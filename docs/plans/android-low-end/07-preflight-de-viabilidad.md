# 07 — Preflight: avisar antes de intentar lo imposible

**Depende de:** 01 (perfil de dispositivo), 05 (comprobación de espacio).
**Toca:** `apps/desktop/src-tauri/src/commands/project.rs`, frontend de import,
i18n.
**Riesgo:** bajo. Es un diálogo previo; no cambia el camino de datos.

## Problema

En el incidente del 20-08, la app aceptó sin rechistar un paquete de 2,02 GiB en
un teléfono con 2,58 GB de RAM y 10 GB de disco libre, y **el usuario no supo que
había un problema hasta que se reinició el teléfono**. Ninguna de las cifras que
lo predecían era secreta: el tamaño del zip, el espacio libre y la RAM del
dispositivo estaban todas disponibles antes de escribir el primer byte.

Este paso es el que convierte el incidente en un diálogo.

## Cambio pedido

### 1. Comando de preflight

```rust
#[tauri::command]
pub fn preflight_session_import(app: AppHandle, package: FilePath)
    -> Result<ImportPreflight, String>;

pub struct ImportPreflight {
    pub package_bytes: u64,
    pub uncompressed_bytes: u64,   // del directorio central del zip
    pub required_bytes: u64,       // descomprimido + margen de caché
    pub free_disk_bytes: u64,
    pub device_class: String,      // del paso 01
    pub verdict: ImportVerdict,
    pub track_count: u32,          // si el manifiesto lo permite sin extraer
}

pub enum ImportVerdict {
    Ok,
    Tight { reason: String },     // cabe, pero justo → avisar y dejar seguir
    Refuse { reason: String },    // no cabe → no dejar seguir
}
```

Debe leer **solo el directorio central del zip**, sin descomprimir nada. Es
rápido incluso sobre SAF.

### 2. Reglas del veredicto

| Condición | Veredicto |
| --- | --- |
| `uncompressed + 1 GB > free_disk` | `Refuse` — sin espacio |
| Móvil y `uncompressed > 1,5 GB` | `Tight` — «esta sesión es muy grande para este dispositivo» |
| Móvil `Constrained` y `uncompressed > 3 GB` | `Refuse` |
| resto | `Ok` |

Los umbrales son un punto de partida: 1,5 GB es aproximadamente el tamaño a
partir del cual el Oppo empieza a sufrir de verdad. Ajústalos si la medición del
paso 09 dice otra cosa, y actualiza este documento.

### 3. Diálogo

Con `Tight`, un diálogo que **no bloquee** pero informe honestamente:

> Esta sesión ocupa 2,1 GB descomprimida y este dispositivo tiene 2,5 GB de
> memoria. La importación puede tardar varios minutos y la aplicación puede ir
> lenta.
>
> **Consejo:** exporta la sesión en modo **Optimizado** o **Ligero** desde el
> ordenador para que funcione mejor aquí.
>
> [Cancelar] [Importar de todos modos]

Con `Refuse`, solo mensaje + [Entendido], nombrando la cifra que falta.

**El usuario siempre puede continuar en `Tight`.** No somos su niñera; si
reafirma, se importa.

### 4. Mismo preflight al abrir

No solo al importar: abrir una sesión ya extraída que no cabe en RAM tiene el
mismo problema. Aplicar el mismo veredicto en el flujo de apertura, midiendo el
tamaño del directorio de audio.

## Criterios de aceptación

- [ ] `preflight_session_import` no descomprime nada: test que lo verifica con
      un zip grande midiendo que no se escribe en disco.
- [ ] Los tres veredictos se producen en las condiciones descritas; test
      parametrizado con tamaños y espacios libres inyectados.
- [ ] En escritorio con espacio de sobra, el veredicto es `Ok` y **no aparece
      ningún diálogo nuevo** (regresión cero de UX en PC).
- [ ] En el Oppo, con `WhatAGod-Reckless.ltset`, el veredicto es `Tight` (o
      `Refuse` si `Constrained`) y el diálogo aparece **antes** de escribir nada.
      Verificación manual en el dispositivo — es el criterio central del paso.
- [ ] «Importar de todos modos» procede con la importación completa.
- [ ] Textos localizados es/en.
- [ ] Tests de frontend del diálogo (render de los tres veredictos).

## Notas para el implementador

- El mensaje debe dar **una salida concreta**, no solo malas noticias: nombra el
  modo Optimizado (paso 06) o Ligero. Un error accionable, en la línea del
  commit `26283606`.
- No inventes un sistema de diálogos nuevo; usa el que ya tenga el frontend.
