/** `IP:PORT` from the host's QR link (`libretracks://join?host=IP:PORT&name=…`),
 * for the Join tab's address field. Apart from `networkApi` so it can be
 * tested without a window. */
export function joinTargetFromLink(url: string): string | null {
  const query = url.split("?")[1];
  if (!query) return null;
  const host = new URLSearchParams(query).get("host")?.trim();
  return host ? host : null;
}
