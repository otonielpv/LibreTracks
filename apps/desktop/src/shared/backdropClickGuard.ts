// Los modales se cierran con `onClick` en su fondo (`.lt-modal-backdrop`,
// `.lt-rhythm-backdrop`...). Si se pulsa dentro del modal (p. ej. para
// seleccionar texto de un campo) y se suelta fuera, el navegador dispara el
// `click` en el ancestro comun de ambos puntos: el propio fondo. El modal se
// cerraba al arrastrar una seleccion fuera de la ventana.
//
// Un unico guardia global en fase de captura en `window` (antes de que React,
// que escucha en el contenedor raiz, vea el evento): un `click` cuyo destino es
// un fondo solo pasa si la pulsacion tambien empezo en ese mismo fondo.

const BACKDROP_CLASS = /(^|\s)[\w-]*backdrop(\s|$)/;

function isBackdrop(target: EventTarget | null): target is Element {
  return target instanceof Element && BACKDROP_CLASS.test(target.getAttribute("class") ?? "");
}

export function installBackdropClickGuard(win: Window = window): () => void {
  let pressTarget: EventTarget | null = null;

  const onPress = (event: Event) => {
    pressTarget = event.target;
  };
  const onClick = (event: MouseEvent) => {
    const started = pressTarget;
    pressTarget = null;
    // Clic sintetico (teclado, element.click(), tests sin pulsacion): no tocar.
    if (started === null) return;
    if (isBackdrop(event.target) && started !== event.target) {
      event.stopPropagation();
    }
  };

  win.addEventListener("pointerdown", onPress, true);
  win.addEventListener("mousedown", onPress, true);
  win.addEventListener("click", onClick, true);
  return () => {
    win.removeEventListener("pointerdown", onPress, true);
    win.removeEventListener("mousedown", onPress, true);
    win.removeEventListener("click", onClick, true);
  };
}
