import type { ZodSchema, ZodError } from "zod";

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export class ApiResponseValidationError extends ApiError {
  zodError: ZodError;

  constructor(message: string, zodError: ZodError) {
    super(message, 0, null);
    this.name = "ApiResponseValidationError";
    this.zodError = zodError;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  schema?: ZodSchema<T>,
): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json();
  if (!schema) return json as T;
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // dev-visible breadcrumb so the field-mismatch is easy to spot in console
    // eslint-disable-next-line no-console
    console.error(`[api] ${path} response shape mismatch`, parsed.error.errors);
    throw new ApiResponseValidationError(
      `Response shape mismatch for ${path}`,
      parsed.error,
    );
  }
  return parsed.data;
}

export const api = {
  get: <T>(path: string, schema?: ZodSchema<T>) => request<T>(path, undefined, schema),
  post: <T>(path: string, body: unknown, schema?: ZodSchema<T>) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }, schema),
  postForm: <T>(path: string, body: FormData, schema?: ZodSchema<T>) =>
    request<T>(path, { method: "POST", body }, schema),
  put: <T>(path: string, body: unknown, schema?: ZodSchema<T>) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }, schema),
  patch: <T>(path: string, body: unknown, schema?: ZodSchema<T>) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }, schema),
  delete: <T>(path: string, schema?: ZodSchema<T>) =>
    request<T>(path, { method: "DELETE" }, schema),
};
