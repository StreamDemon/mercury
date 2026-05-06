/**
 * CLI output formatting for Hermes Agent adapter.
 *
 * Pretty-prints Hermes output lines in the terminal when running
 * Mercury's CLI tools.
 */
/**
 * Format a Hermes Agent stdout event for terminal display.
 *
 * @param raw    Raw stdout line from Hermes
 * @param debug  If true, show extra metadata with color coding
 */
export declare function printHermesStreamEvent(raw: string, debug: boolean): void;
