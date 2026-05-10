import pc from "picocolors";
import { mercury } from "./colors.js";

const MERCURY_ART = [
  "███╗   ███╗███████╗██████╗  ██████╗██╗   ██╗██████╗ ██╗   ██╗",
  "████╗ ████║██╔════╝██╔══██╗██╔════╝██║   ██║██╔══██╗╚██╗ ██╔╝",
  "██╔████╔██║█████╗  ██████╔╝██║     ██║   ██║██████╔╝ ╚████╔╝ ",
  "██║╚██╔╝██║██╔══╝  ██╔══██╗██║     ██║   ██║██╔══██╗  ╚██╔╝  ",
  "██║ ╚═╝ ██║███████╗██║  ██║╚██████╗╚██████╔╝██║  ██║   ██║   ",
  "╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ",
] as const;

const TAGLINE = "Open-source orchestration for zero-human companies";

export function printMercuryCliBanner(): void {
  const lines = [
    "",
    ...MERCURY_ART.map((line) => mercury.brand(line)),
    mercury.dark("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
