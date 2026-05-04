import { afterEach, describe, expect, it } from "vitest";
import { buildMercuryEnv } from "../adapters/utils.js";

const ORIGINAL_MERCURY_RUNTIME_API_URL = process.env.MERCURY_RUNTIME_API_URL;
const ORIGINAL_MERCURY_API_URL = process.env.MERCURY_API_URL;
const ORIGINAL_MERCURY_LISTEN_HOST = process.env.MERCURY_LISTEN_HOST;
const ORIGINAL_MERCURY_LISTEN_PORT = process.env.MERCURY_LISTEN_PORT;
const ORIGINAL_HOST = process.env.HOST;
const ORIGINAL_PORT = process.env.PORT;

afterEach(() => {
  if (ORIGINAL_MERCURY_RUNTIME_API_URL === undefined) delete process.env.MERCURY_RUNTIME_API_URL;
  else process.env.MERCURY_RUNTIME_API_URL = ORIGINAL_MERCURY_RUNTIME_API_URL;

  if (ORIGINAL_MERCURY_API_URL === undefined) delete process.env.MERCURY_API_URL;
  else process.env.MERCURY_API_URL = ORIGINAL_MERCURY_API_URL;

  if (ORIGINAL_MERCURY_LISTEN_HOST === undefined) delete process.env.MERCURY_LISTEN_HOST;
  else process.env.MERCURY_LISTEN_HOST = ORIGINAL_MERCURY_LISTEN_HOST;

  if (ORIGINAL_MERCURY_LISTEN_PORT === undefined) delete process.env.MERCURY_LISTEN_PORT;
  else process.env.MERCURY_LISTEN_PORT = ORIGINAL_MERCURY_LISTEN_PORT;

  if (ORIGINAL_HOST === undefined) delete process.env.HOST;
  else process.env.HOST = ORIGINAL_HOST;

  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;
});

describe("buildMercuryEnv", () => {
  it("prefers an explicit MERCURY_RUNTIME_API_URL", () => {
    process.env.MERCURY_RUNTIME_API_URL = "http://100.104.161.29:3102";
    process.env.MERCURY_API_URL = "http://localhost:4100";
    process.env.MERCURY_LISTEN_HOST = "127.0.0.1";
    process.env.MERCURY_LISTEN_PORT = "3101";

    const env = buildMercuryEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.MERCURY_API_URL).toBe("http://100.104.161.29:3102");
  });

  it("falls back to MERCURY_API_URL when no runtime URL is configured", () => {
    delete process.env.MERCURY_RUNTIME_API_URL;
    process.env.MERCURY_API_URL = "http://localhost:4100";
    process.env.MERCURY_LISTEN_HOST = "127.0.0.1";
    process.env.MERCURY_LISTEN_PORT = "3101";

    const env = buildMercuryEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.MERCURY_API_URL).toBe("http://localhost:4100");
  });

  it("uses runtime listen host/port when explicit URL is not set", () => {
    delete process.env.MERCURY_API_URL;
    process.env.MERCURY_LISTEN_HOST = "0.0.0.0";
    process.env.MERCURY_LISTEN_PORT = "3101";
    process.env.PORT = "3100";

    const env = buildMercuryEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.MERCURY_API_URL).toBe("http://localhost:3101");
  });

  it("formats IPv6 hosts safely in fallback URL generation", () => {
    delete process.env.MERCURY_API_URL;
    process.env.MERCURY_LISTEN_HOST = "::1";
    process.env.MERCURY_LISTEN_PORT = "3101";

    const env = buildMercuryEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.MERCURY_API_URL).toBe("http://[::1]:3101");
  });
});
