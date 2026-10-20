import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("meme-sdk", () => {
  it("exports version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
