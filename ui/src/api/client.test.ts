import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { api, ApiError, ApiResponseValidationError } from "./client";

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
});

function mockJsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("api client response validation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // suppress the dev-breadcrumb console.error from polluting the test log;
    // we don't assert on it (don't pin behavior to console output).
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the parsed value when the response matches the schema", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ id: "u1", name: "Mercury" }));

    const result = await api.get("/users/u1", userSchema);

    expect(result).toEqual({ id: "u1", name: "Mercury" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/users/u1",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("throws ApiResponseValidationError when the response shape is invalid", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ id: 123, name: "Mercury" }));

    await expect(api.get("/users/u1", userSchema)).rejects.toBeInstanceOf(
      ApiResponseValidationError,
    );
  });

  it("the validation error is also an ApiError (subclass invariant)", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ wrong: "shape" }));

    let caught: unknown;
    try {
      await api.get("/users/u1", userSchema);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toBeInstanceOf(ApiResponseValidationError);
  });

  it("the validation error carries a populated ZodError", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ id: 1, name: 2 }));

    let caught: ApiResponseValidationError | undefined;
    try {
      await api.get("/users/u1", userSchema);
    } catch (err) {
      caught = err as ApiResponseValidationError;
    }

    expect(caught).toBeDefined();
    expect(caught?.zodError).toBeDefined();
    expect(caught?.zodError.errors.length).toBeGreaterThan(0);
    expect(caught?.status).toBe(0);
  });

  it("returns raw JSON unchanged when no schema is supplied (preserves existing behavior)", async () => {
    const raw = { id: "u1", name: "Mercury", extra: "kept" };
    fetchMock.mockResolvedValue(mockJsonResponse(raw));

    const result = await api.get<typeof raw>("/users/u1");

    expect(result).toBe(raw);
  });

  it("strips unknown keys when a non-strict schema parses the response", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({ id: "u1", name: "Mercury", extra: "stripped" }),
    );

    const result = await api.get("/users/u1", userSchema);

    expect(result).toEqual({ id: "u1", name: "Mercury" });
    expect(result).not.toHaveProperty("extra");
  });

  it("api.post parses the response when given a schema", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ id: "u2", name: "Created" }));

    const result = await api.post("/users", { name: "Created" }, userSchema);

    expect(result).toEqual({ id: "u2", name: "Created" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/users",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Created" }),
      }),
    );
  });

  it("non-2xx response still throws ApiError (not ApiResponseValidationError) even with a schema", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({ error: "not found" }, { status: 404 }),
    );

    let caught: unknown;
    try {
      await api.get("/users/missing", userSchema);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).not.toBeInstanceOf(ApiResponseValidationError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe("not found");
  });
});
