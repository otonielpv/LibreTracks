import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { MulticoreAudioField } from "./MulticoreAudioField";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

it("presents multicore processing as a positive on/off option", () => {
  const onChange = vi.fn();
  render(
    <MulticoreAudioField
      singleThreadRender={false}
      onSingleThreadRenderChange={onChange}
    />,
  );

  const toggle = screen.getByRole("checkbox", {
    name: /multicore processing/i,
  });
  expect((toggle as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();

  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith(true);
});
