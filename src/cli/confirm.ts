import * as readline from "node:readline";

export interface ConfirmOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * Ask a yes/no question, defaulting to no.
 *
 * The caller is responsible for checking that stdin is a TTY first. Prompting
 * a process that cannot answer would hang a CI job forever, which is a worse
 * failure than refusing outright.
 */
export async function confirm(question: string, options: ConfirmOptions = {}): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} [y/N] `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
