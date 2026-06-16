import { describe, expect, it } from "bun:test";
import { WssServiceError, buildServiceError } from "./errors.js";

describe("buildServiceError", () => {
  it("preserves structured data for object params with kind/message", () => {
    const err = buildServiceError({
      type: "Error",
      method: 12,
      code: 100404,
      seq: 7,
      params: { kind: "UserNotFound", message: "User not found" },
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WssServiceError);
    expect(err.name).toBe("WssServiceError");
    expect(err.message).toBe("User not found");
    expect(err.serviceMessage).toBe("User not found");
    expect(err.kind).toBe("UserNotFound");
    expect((err.params as { kind: string }).kind).toBe("UserNotFound");
    expect(err.code).toBe(100404);
    expect(err.method).toBe(12);
    expect(err.seq).toBe(7);
  });

  it("uses a string params value as the message", () => {
    const err = buildServiceError({
      type: "Error",
      code: 100401,
      params: "Invalid password",
    });

    expect(err.message).toBe("Invalid password");
    expect(err.serviceMessage).toBe("Invalid password");
    expect(err.params).toBe("Invalid password");
    expect(err.kind).toBeUndefined();
  });

  it("falls back to a generic message when object params has no message", () => {
    const err = buildServiceError({
      type: "Error",
      code: 100400,
      params: { kind: "BadRequest", field: "username" },
    });

    expect(err.message).toBe("Service request failed");
    expect(err.kind).toBe("BadRequest");
    expect((err.params as { field: string }).field).toBe("username");
  });

  it("preserves data the same way on the connect/init envelope", () => {
    const err = buildServiceError({
      type: "Error",
      method: 20000,
      code: 100403,
      seq: 0,
      params: { kind: "AccountForbidden", message: "Account is forbidden" },
    });

    expect(err.message).toBe("Account is forbidden");
    expect(err.kind).toBe("AccountForbidden");
    expect(err.code).toBe(100403);
    expect(err.method).toBe(20000);
  });

  it("supports legacy reason/error params for back-compat", () => {
    expect(
      buildServiceError({ code: 1, params: { reason: "boom" } }).message
    ).toBe("boom");
    expect(
      buildServiceError({ code: 1, params: { error: "kaboom" } }).message
    ).toBe("kaboom");
  });

  it("uses the catalog message when params carries no usable text", () => {
    const err = buildServiceError(
      { code: 100500, params: {} },
      { catalogMessage: "Internal error" }
    );
    expect(err.message).toBe("Internal error");
  });

  it("never produces an [object Object] message and stays catchable as Error", () => {
    const err = buildServiceError({
      code: 100400,
      params: { kind: "BadRequest" },
    });
    expect(err.message).not.toContain("[object Object]");

    try {
      throw err;
    } catch (caught) {
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain("[object Object]");
    }
  });
});

describe("WssServiceError", () => {
  it("exposes the cause for consumers reading error.cause", () => {
    const err = new WssServiceError("nope", { code: 100400, cause: 100400 });
    expect(err.cause).toBe(100400);
    expect(err.code).toBe(100400);
  });
});
