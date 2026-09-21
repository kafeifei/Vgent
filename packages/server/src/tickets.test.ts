import { describe, expect, it } from "vitest";
import { createTickets } from "./tickets.js";

const content = (byte: number) => ({ mediaType: "image/png", bytes: new Uint8Array([byte]) });
const id = (char: string): string => char.repeat(32);

describe("createTickets", () => {
  it("serves a ticket until it expires", async () => {
    let time = 0;
    const tickets = createTickets({ ttlMs: 1000, waitMs: 0, now: () => time });
    expect(tickets.register(id("a"), content(1))).toBe(true);
    expect(await tickets.read(id("a"))).toEqual(content(1));
    expect(await tickets.read(id("a"))).toEqual(content(1));
    expect(await tickets.read(id("b"))).toBeUndefined();
    time = 1000;
    expect(await tickets.read(id("a"))).toBeUndefined();
  });

  it("refuses an id that is no secret, and one that is taken", () => {
    const tickets = createTickets({ waitMs: 0 });
    expect(tickets.register("short", content(1))).toBe(false);
    expect(tickets.register(`${id("a")}/../x`, content(1))).toBe(false);
    expect(tickets.register(id("a"), content(1))).toBe(true);
    expect(tickets.register(id("a"), content(2))).toBe(false);
  });

  it("waits for a ticket that is registered a moment after it is asked for", async () => {
    const tickets = createTickets({ waitMs: 2000 });
    const pending = tickets.read(id("c"));
    tickets.register(id("c"), content(3));
    expect(await pending).toEqual(content(3));
    expect(await createTickets({ waitMs: 10 }).read(id("d"))).toBeUndefined();
  });

  it("drops the oldest beyond its cap", async () => {
    const tickets = createTickets({ max: 2, waitMs: 0 });
    for (const char of ["a", "b", "c"]) tickets.register(id(char), content(char.charCodeAt(0)));
    expect(await tickets.read(id("a"))).toBeUndefined();
    expect(await tickets.read(id("c"))).toEqual(content(99));
  });
});
