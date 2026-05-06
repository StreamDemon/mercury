import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Names exported by paths.ts, config-discovery.ts, and env-file.ts.
// These modules import from node:fs / node:os / node:path at the top, so
// re-exporting them from the main barrel pulls Node-only code into the UI's
// import graph and breaks the browser bundle. Server/CLI/db code must use
// the explicit subpath imports (`@mercuryai/shared/paths` etc.) instead.
const NODE_ONLY_NAMES_THAT_MUST_NOT_LEAK = [
  // paths.ts
  "DEFAULT_INSTANCE_ID",
  "INSTANCE_ID_RE",
  "expandHomePrefix",
  "resolveDefaultBackupDir",
  "resolveDefaultConfigPath",
  "resolveDefaultEmbeddedPostgresDir",
  "resolveDefaultLogsDir",
  "resolveDefaultSecretsKeyFilePath",
  "resolveDefaultStorageDir",
  "resolveHomeAwarePath",
  "resolveMercuryHomeDir",
  "resolveMercuryInstanceId",
  "resolveMercuryInstanceRoot",
  // config-discovery.ts
  "findConfigFileFromAncestors",
  "migrateLegacyConfig",
  "resolveMercuryConfigPath",
  "resolveMercuryEnvPath",
  // env-file.ts
  "formatEnvEntries",
  "loadEnvFileIntoProcessEnv",
  "parseEnvFile",
  "readEnvEntries",
] as const;

describe("@mercuryai/shared main barrel browser safety", () => {
  it.each(NODE_ONLY_NAMES_THAT_MUST_NOT_LEAK)(
    "must not re-export Node-only symbol %s",
    (name) => {
      expect(shared).not.toHaveProperty(name);
    },
  );
});
