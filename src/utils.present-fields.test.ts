import { describe, it, expect } from "vitest";
import { presentFields } from "./utils";

describe("presentFields", () => {
  it("drops the three shapes of 'nothing' and keeps everything else", () => {
    expect(presentFields({ a: "x", b: "", c: null, d: undefined, e: "  ", f: 0 }))
      .toEqual({ a: "x", f: 0 });
  });

  it("survives a missing layer, which is how guest orders arrive", () => {
    expect(presentFields(null)).toEqual({});
    expect(presentFields(undefined)).toEqual({});
  });

  // The property the address merge depends on: a later layer can still win, but
  // only where it has something to say.
  it("lets a filled layer win and a blank one lose", () => {
    const merged = {
      ...presentFields({ street: "Av. da Liberdade nº 110", city: "Lisboa" }),
      ...presentFields({ street: "", city: "Porto" }),
    };
    expect(merged).toEqual({ street: "Av. da Liberdade nº 110", city: "Porto" });
  });
});
