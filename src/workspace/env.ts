/**
 * Parse a .env file.
 *
 * Deliberately small: enough to read a DATABASE_URL out of the file almost
 * every project already has, without taking on a dependency for it. Handles
 * blank lines, # comments, an optional `export ` prefix, quoted values, and
 * values containing `=`.
 */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim().replace(/^export\s+/, "");
    if (key === "") continue;

    let value = trimmed.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at a trailing comment, but only one introduced
      // by whitespace - a # inside a password is part of the password.
      value = value.split(/\s+#/)[0]!.trim();
    }

    values[key] = value;
  }

  return values;
}
