/** Reload the whole UI (enter or leave network-session mirror mode). Its own
 * module so tests can replace it: jsdom cannot reload. */
export function reloadApp() {
  window.location.reload();
}
