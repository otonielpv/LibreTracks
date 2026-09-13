type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Pone en palabras los perfiles de red que devuelve Windows.
 *
 * `Private` / `Public` / `Domain` son etiquetas del sistema, no algo que se le
 * pueda enseñar a alguien tal cual en mitad de una frase: el mensaje del aviso
 * dice "estás en una red {{active}}", y ahí hace falta "privada", no "Private".
 *
 * Aparte, la lista puede venir vacía (ninguna regla, o ninguna red conectada) y
 * la frase tiene que seguir leyéndose, de ahí el "ninguna".
 */
export function describeFirewallProfiles(
  profiles: string[],
  t: Translate,
): string {
  const words = profiles
    .map((profile) => {
      if (profile === "Private") {
        return t("remoteAccess.firewall.profilePrivate", {
          defaultValue: "privada",
        });
      }
      if (profile === "Public") {
        return t("remoteAccess.firewall.profilePublic", {
          defaultValue: "publica",
        });
      }
      if (profile === "Domain") {
        return t("remoteAccess.firewall.profileDomain", {
          defaultValue: "de dominio",
        });
      }
      // "Any" o cualquier etiqueta nueva de Microsoft: se enseña tal cual en
      // vez de tragársela, que es peor que un término en inglés suelto.
      return profile;
    })
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return t("remoteAccess.firewall.profileNone", { defaultValue: "ninguna" });
  }
  return words.join(" / ");
}
