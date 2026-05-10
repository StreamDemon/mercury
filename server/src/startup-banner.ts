import { existsSync, readFileSync } from "node:fs";
import { resolveMercuryConfigPath, resolveMercuryEnvPath } from "./paths.js";
import type { BindMode, DeploymentExposure, DeploymentMode } from "@mercuryai/shared";
import { parseEnvFile } from "@mercuryai/shared/env-file";

type UiMode = "none" | "static" | "vite-dev";

type ExternalPostgresInfo = {
  mode: "external-postgres";
  connectionString: string;
};

type EmbeddedPostgresInfo = {
  mode: "embedded-postgres";
  dataDir: string;
  port: number;
};

type StartupBannerOptions = {
  bind: BindMode;
  host: string;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  authReady: boolean;
  requestedPort: number;
  listenPort: number;
  uiMode: UiMode;
  db: ExternalPostgresInfo | EmbeddedPostgresInfo;
  migrationSummary: string;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
};

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  // Mercury brand orange (#F47B20), emitted unconditionally as a 24-bit
  // truecolor escape. There is no in-code degradation here — the CLI
  // banner (cli/src/utils/banner.ts) implements isColorSupported +
  // COLORTERM detection with a yellow fallback, but this server file
  // does not. Acceptable today because the server banner only renders
  // at boot in dev contexts (Docker exec, IDE terminal, GHA logs) where
  // truecolor is universally supported; if that ever changes, lift the
  // CLI's mercuryOrange() helper into a shared util and use it here.
  mercuryOrange: "\x1b[38;2;244;123;32m",
};

function color(text: string, c: keyof typeof ansi): string {
  return `${ansi[c]}${text}${ansi.reset}`;
}

function row(label: string, value: string): string {
  return `${color(label.padEnd(16), "dim")} ${value}`;
}

function redactConnectionString(raw: string): string {
  try {
    const u = new URL(raw);
    const user = u.username || "user";
    const auth = `${user}:***@`;
    return `${u.protocol}//${auth}${u.host}${u.pathname}`;
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

function resolveAgentJwtSecretStatus(
  envFilePath: string,
): {
  status: "pass" | "warn";
  message: string;
} {
  const envValue = process.env.MERCURY_AGENT_JWT_SECRET?.trim();
  if (envValue) {
    return {
      status: "pass",
      message: "set",
    };
  }

  if (existsSync(envFilePath)) {
    const parsed = parseEnvFile(readFileSync(envFilePath, "utf-8"));
    const fileValue = typeof parsed.MERCURY_AGENT_JWT_SECRET === "string" ? parsed.MERCURY_AGENT_JWT_SECRET.trim() : "";
    if (fileValue) {
      return {
        status: "warn",
        message: `found in ${envFilePath} but not loaded`,
      };
    }
  }

  return {
    status: "warn",
    message: "missing (run `pnpm mercuryai onboard`)",
  };
}

export function printStartupBanner(opts: StartupBannerOptions): void {
  const baseHost = opts.host === "0.0.0.0" ? "localhost" : opts.host;
  const baseUrl = `http://${baseHost}:${opts.listenPort}`;
  const apiUrl = `${baseUrl}/api`;
  const uiUrl = opts.uiMode === "none" ? "disabled" : baseUrl;
  const configPath = resolveMercuryConfigPath();
  const envFilePath = resolveMercuryEnvPath();
  const agentJwtSecret = resolveAgentJwtSecretStatus(envFilePath);

  const dbMode =
    opts.db.mode === "embedded-postgres"
      ? color("embedded-postgres", "green")
      : color("external-postgres", "yellow");
  const uiMode =
    opts.uiMode === "vite-dev"
      ? color("vite-dev-middleware", "cyan")
      : opts.uiMode === "static"
        ? color("static-ui", "magenta")
        : color("headless-api", "yellow");

  const portValue =
    opts.requestedPort === opts.listenPort
      ? `${opts.listenPort}`
      : `${opts.listenPort} ${color(`(requested ${opts.requestedPort})`, "dim")}`;

  const dbDetails =
    opts.db.mode === "embedded-postgres"
      ? `${opts.db.dataDir} ${color(`(pg:${opts.db.port})`, "dim")}`
      : redactConnectionString(opts.db.connectionString);

  const heartbeat = opts.heartbeatSchedulerEnabled
    ? `enabled ${color(`(${opts.heartbeatSchedulerIntervalMs}ms)`, "dim")}`
    : color("disabled", "yellow");
  const dbBackup = opts.databaseBackupEnabled
    ? `enabled ${color(`(every ${opts.databaseBackupIntervalMinutes}m, keep ${opts.databaseBackupRetentionDays}d)`, "dim")}`
    : color("disabled", "yellow");

  const art = [
    color("███╗   ███╗███████╗██████╗  ██████╗██╗   ██╗██████╗ ██╗   ██╗", "mercuryOrange"),
    color("████╗ ████║██╔════╝██╔══██╗██╔════╝██║   ██║██╔══██╗╚██╗ ██╔╝", "mercuryOrange"),
    color("██╔████╔██║█████╗  ██████╔╝██║     ██║   ██║██████╔╝ ╚████╔╝ ", "mercuryOrange"),
    color("██║╚██╔╝██║██╔══╝  ██╔══██╗██║     ██║   ██║██╔══██╗  ╚██╔╝  ", "mercuryOrange"),
    color("██║ ╚═╝ ██║███████╗██║  ██║╚██████╗╚██████╔╝██║  ██║   ██║   ", "mercuryOrange"),
    color("╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ", "mercuryOrange"),
  ];

  const lines = [
    "",
    ...art,
    color("  ───────────────────────────────────────────────────────", "blue"),
    row("Mode", `${dbMode}  |  ${uiMode}`),
    row("Deploy", `${opts.deploymentMode} (${opts.deploymentExposure})`),
    row("Bind", `${opts.bind} ${color(`(${opts.host})`, "dim")}`),
    row("Auth", opts.authReady ? color("ready", "green") : color("not-ready", "yellow")),
    row("Server", portValue),
    row("API", `${apiUrl} ${color(`(health: ${apiUrl}/health)`, "dim")}`),
    row("UI", uiUrl),
    row("Database", dbDetails),
    row("Migrations", opts.migrationSummary),
    row(
      "Agent JWT",
      agentJwtSecret.status === "pass"
        ? color(agentJwtSecret.message, "green")
        : color(agentJwtSecret.message, "yellow"),
    ),
    row("Heartbeat", heartbeat),
    row("DB Backup", dbBackup),
    row("Backup Dir", opts.databaseBackupDir),
    row("Config", configPath),
    agentJwtSecret.status === "warn"
      ? color("  ───────────────────────────────────────────────────────", "yellow")
      : null,
    color("  ───────────────────────────────────────────────────────", "blue"),
    "",
  ];

  console.log(lines.filter((line): line is string => line !== null).join("\n"));
}
