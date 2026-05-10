import pc from "picocolors";

const MERCURY_ART = [
  "███╗   ███╗███████╗██████╗  ██████╗██╗   ██╗██████╗ ██╗   ██╗",
  "████╗ ████║██╔════╝██╔══██╗██╔════╝██║   ██║██╔══██╗╚██╗ ██╔╝",
  "██╔████╔██║█████╗  ██████╔╝██║     ██║   ██║██████╔╝ ╚████╔╝ ",
  "██║╚██╔╝██║██╔══╝  ██╔══██╗██║     ██║   ██║██╔══██╗  ╚██╔╝  ",
  "██║ ╚═╝ ██║███████╗██║  ██║╚██████╗╚██████╔╝██║  ██║   ██║   ",
  "╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ",
] as const;

const TAGLINE = "Open-source orchestration for zero-human companies";

// Mercury brand orange (#F47B20). Truecolor in capable terminals, yellow
// fallback in 16-color terminals, plain text when color is suppressed
// (NO_COLOR, non-TTY, etc.) — mirrors picocolors' detection.
function mercuryOrange(text: string): string {
  if (!pc.isColorSupported) return text;
  const colorTerm = process.env.COLORTERM ?? "";
  if (/truecolor|24bit/i.test(colorTerm)) {
    return `\x1b[38;2;244;123;32m${text}\x1b[0m`;
  }
  return pc.yellow(text);
}

export function printMercuryCliBanner(): void {
  const lines = [
    "",
    ...MERCURY_ART.map((line) => mercuryOrange(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
