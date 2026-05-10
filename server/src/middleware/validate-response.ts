import type { Request, Response, NextFunction } from "express";
import { ZodError, type ZodSchema } from "zod";

export class ResponseValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly zodError: ZodError,
  ) {
    super(`Response validation failed for ${path}: ${zodError.message}`);
    this.name = "ResponseValidationError";
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Response {
      jsonValidated<T>(schema: ZodSchema<T>, value: unknown): Response;
    }
  }
}

export function responseValidationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  res.jsonValidated = function jsonValidated<T>(
    schema: ZodSchema<T>,
    value: unknown,
  ) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ResponseValidationError(req.originalUrl, parsed.error);
    }
    return res.json(parsed.data);
  };
  next();
}
