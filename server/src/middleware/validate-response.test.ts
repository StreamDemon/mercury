import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import {
  ResponseValidationError,
  responseValidationMiddleware,
} from "./validate-response.js";

interface ResHarness {
  res: Response;
  jsonCalls: unknown[];
}

const makeReq = (originalUrl = "/api/example"): Request => {
  return { originalUrl } as Request;
};

const makeRes = (): ResHarness => {
  const jsonCalls: unknown[] = [];
  const res = {
    json(body: unknown) {
      jsonCalls.push(body);
      return this;
    },
  } as unknown as Response;
  return { res, jsonCalls };
};

const decorate = (req: Request, res: Response) => {
  const next = vi.fn() as unknown as NextFunction;
  responseValidationMiddleware(req, res, next);
  return next as unknown as ReturnType<typeof vi.fn>;
};

describe("responseValidationMiddleware", () => {
  it("calls next() and decorates res.jsonValidated without throwing", () => {
    const req = makeReq();
    const { res } = makeRes();
    const next = decorate(req, res);
    expect(next).toHaveBeenCalledOnce();
    expect(typeof res.jsonValidated).toBe("function");
  });

  it("res.jsonValidated returns the response object on success", () => {
    const req = makeReq("/api/widgets");
    const { res, jsonCalls } = makeRes();
    decorate(req, res);
    const schema = z.object({ name: z.string() });
    const result = res.jsonValidated(schema, { name: "alpha" });
    expect(result).toBe(res);
    expect(jsonCalls).toEqual([{ name: "alpha" }]);
  });

  it("res.jsonValidated throws ResponseValidationError on schema mismatch", () => {
    const req = makeReq("/api/widgets/42");
    const { res, jsonCalls } = makeRes();
    decorate(req, res);
    const schema = z.object({ name: z.string() });
    expect(() => res.jsonValidated(schema, { name: 123 })).toThrow(
      ResponseValidationError,
    );
    expect(jsonCalls).toEqual([]);
  });

  it("the thrown error's .path matches req.originalUrl", () => {
    const req = makeReq("/api/widgets/42?refresh=1");
    const { res } = makeRes();
    decorate(req, res);
    const schema = z.object({ name: z.string() });
    try {
      res.jsonValidated(schema, { name: 123 });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ResponseValidationError);
      expect((err as ResponseValidationError).path).toBe(
        "/api/widgets/42?refresh=1",
      );
    }
  });

  it("the thrown error's .zodError is a ZodError carrying issues", () => {
    const req = makeReq();
    const { res } = makeRes();
    decorate(req, res);
    const schema = z.object({ name: z.string(), age: z.number() });
    try {
      res.jsonValidated(schema, { name: "x" });
      expect.fail("expected throw");
    } catch (err) {
      const ve = err as ResponseValidationError;
      expect(ve.zodError).toBeInstanceOf(ZodError);
      expect(ve.zodError.issues.length).toBeGreaterThan(0);
      expect(ve.zodError.issues[0]?.path).toEqual(["age"]);
    }
  });

  it("ResponseValidationError is not a ZodError (instanceof distinct)", () => {
    const req = makeReq();
    const { res } = makeRes();
    decorate(req, res);
    const schema = z.object({ ok: z.boolean() });
    try {
      res.jsonValidated(schema, { ok: "nope" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ResponseValidationError);
      expect(err).not.toBeInstanceOf(ZodError);
      expect((err as Error).name).toBe("ResponseValidationError");
    }
  });

  it("strips extra fields by default (no .strict())", () => {
    const req = makeReq();
    const { res, jsonCalls } = makeRes();
    decorate(req, res);
    const schema = z.object({ name: z.string() });
    res.jsonValidated(schema, { name: "alpha", extra: "ignored" });
    expect(jsonCalls).toEqual([{ name: "alpha" }]);
  });

  it("uses safeParse — wraps the failure rather than letting raw ZodError escape", () => {
    const req = makeReq();
    const { res } = makeRes();
    decorate(req, res);
    const schema = z.object({ id: z.string().uuid() });
    let caught: unknown;
    try {
      res.jsonValidated(schema, { id: "not-a-uuid" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseValidationError);
    expect(caught).not.toBeInstanceOf(ZodError);
    expect((caught as ResponseValidationError).message).toContain(
      "Response validation failed for",
    );
  });
});
