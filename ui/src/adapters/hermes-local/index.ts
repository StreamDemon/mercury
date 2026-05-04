import type { UIAdapterModule } from "../types";
import { parseHermesStdoutLine } from "@mercuryai/adapter-hermes/ui";
import { buildHermesConfig } from "@mercuryai/adapter-hermes/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
