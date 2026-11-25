import { describe, expect, it } from "vitest";

import { render } from "../../../test/testUtils";
import { useBackDismissStore } from "../mobile/backNavigation";
import { ExportSongModal } from "./ExportSongModal";

// Vive siempre montado: cerrado no puede ocupar la pila del botón atrás, o el
// primer atrás de Android se gasta en él y no cierra lo que hay delante.
describe("ExportSongModal y el botón atrás", () => {
  it("cerrado no se registra en la pila", () => {
    useBackDismissStore.setState({ stack: [] });
    render(<ExportSongModal target={null} onCancel={() => {}} onConfirm={() => {}} />);
    expect(useBackDismissStore.getState().stack).toEqual([]);
  });
});
