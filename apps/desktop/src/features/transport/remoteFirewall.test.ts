import { describe, expect, it } from "vitest";

import { describeFirewallProfiles } from "./remoteFirewall";

/** `t` de mentira: devuelve el defaultValue, como hace i18next sin traduccion. */
const t = (key: string, options?: Record<string, unknown>) =>
  (options?.defaultValue as string | undefined) ?? key;

describe("describeFirewallProfiles", () => {
  it("traduce las etiquetas de Windows a algo legible en la frase", () => {
    // El mensaje dice "estas en una red {{active}}": ahi no cabe "Private".
    expect(describeFirewallProfiles(["Private"], t)).toBe("privada");
    expect(describeFirewallProfiles(["Public"], t)).toBe("publica");
    expect(describeFirewallProfiles(["Domain"], t)).toBe("de dominio");
  });

  it("junta varias redes conectadas", () => {
    // Cable y wifi a la vez es lo normal en un equipo de estudio.
    expect(describeFirewallProfiles(["Private", "Public"], t)).toBe(
      "privada / publica",
    );
  });

  it("la lista vacia sigue leyendose como una frase", () => {
    // Pasa de verdad: ninguna regla para el programa, o ninguna red conectada.
    expect(describeFirewallProfiles([], t)).toBe("ninguna");
  });

  it("una etiqueta desconocida se enseña tal cual en vez de desaparecer", () => {
    // "Any", o lo que Microsoft añada mañana: mejor un termino en ingles
    // suelto que una frase a la que le falta el sujeto.
    expect(describeFirewallProfiles(["Any"], t)).toBe("Any");
  });
});
