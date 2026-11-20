# Respuestas de los programas de letras

**Sintéticas**: escritas a mano a partir de la documentación oficial
(especificación OpenAPI de ProPresenter, código de FreeShow 1.6.8-beta,
documentación de la API de Holyrics) para la canción de prueba del paso 01
del plan `lyrics-sync`: Intro, Verso 1 (2 diapositivas), Coro (2), Verso 2,
Coro, Puente, Coro, Final.

Hay que sustituirlas por las grabadas con
`cargo run -p libretracks-lyrics --example lyrics_probe -- <programa> <host:puerto> dump <id> <dir>`
(o con `curl`) contra los programas reales, y ajustar los parsers de
`src/structure.rs` si la forma real difiere. Ver
`docs/plans/lyrics-sync/spike-results.md`.
