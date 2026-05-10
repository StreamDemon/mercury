import pc from "picocolors";

// Mercury brand palette — three tones of orange, each with three-tier
// degradation: 24-bit truecolor escape in capable terminals, picocolors
// 16-color fallback elsewhere, plain text when color is suppressed
// (NO_COLOR, non-TTY).
//
// Tones:
//   bright — light peach (#FFB070)  → background chips, highlight backgrounds
//   brand  — Mercury orange (#F47B20) → primary brand accent (wordmark, value highlights)
//   dark   — dark amber (#A04A0A)   → structural rules (divider lines, low-emphasis frames)
//
// The 16-color fallback collapses all three tones to picocolors yellow
// because the standard ANSI palette has no orange/peach. On capable
// terminals (everything modern: Windows Terminal, VS Code, iTerm2,
// modern Linux, GitHub Actions logs), the truecolor branch fires and
// the three tones are visually distinct.

const COLOR_SUPPORTED = pc.isColorSupported;
const TRUECOLOR_RE = /truecolor|24bit/i;
const IS_TRUECOLOR =
  COLOR_SUPPORTED && TRUECOLOR_RE.test(process.env.COLORTERM ?? "");

function fg(rgb: string, fallback: (s: string) => string) {
  return (text: string): string => {
    if (!COLOR_SUPPORTED) return text;
    if (IS_TRUECOLOR) return `\x1b[38;2;${rgb}m${text}\x1b[0m`;
    return fallback(text);
  };
}

function bg(rgb: string, fallback: (s: string) => string) {
  return (text: string): string => {
    if (!COLOR_SUPPORTED) return text;
    if (IS_TRUECOLOR) return `\x1b[48;2;${rgb}m${text}\x1b[0m`;
    return fallback(text);
  };
}

export const mercury = {
  bright: fg("255;176;112", pc.yellow),
  brand: fg("244;123;32", pc.yellow),
  dark: fg("160;74;10", pc.yellow),
  bgBright: bg("255;176;112", pc.bgYellow),
};
