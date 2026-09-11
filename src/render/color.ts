/**
 * Just enough colour, with no dependency.
 *
 * Colour is only ever applied when stdout is a terminal a human is looking at.
 * A pipe, a file, a CI log or NO_COLOR being set all mean plain text, because
 * escape codes in a captured log are worse than no colour at all.
 */
export interface ColorOptions {
  stream?: { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
}

export function isColorEnabled(options: ColorOptions = {}): boolean {
  const { stream = process.stdout, env = process.env } = options;

  // https://no-color.org - any value at all, including an empty one, disables.
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;

  return stream.isTTY === true;
}

const CODES = {
  green: "32",
  red: "31",
  yellow: "33",
  dim: "2",
  bold: "1",
} as const;

export type ColorName = keyof typeof CODES;

/** A painter that either colours its text or hands it back untouched. */
export type Painter = (text: string, color: ColorName) => string;

// Built from the char code rather than written as an escape sequence: a raw
// ESC byte in source is invisible and easy for an editor to mangle, and the
// backslash form is easy for a tool in the chain to eat.
const ESC = String.fromCharCode(27);

export function painter(enabled: boolean): Painter {
  if (!enabled) return (text) => text;
  return (text, color) => `${ESC}[${CODES[color]}m${text}${ESC}[0m`;
}
