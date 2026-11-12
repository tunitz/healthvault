/**
 * Set or verify the HealthVault UI password.
 *
 *   bun scripts/password.ts set    [--file <path>]
 *   bun scripts/password.ts verify [--file <path>]
 *
 * `set` prompts twice with hidden input and writes HEALTHVAULT_PASSWORD_HASH, a session secret,
 * and an agent API token to private files. Secret values are never printed or accepted as
 * arguments. The env and token files are mode 0600.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { expandHomePath } from "../src/lib/auth-config";
import { hashPassword, verifyPasswordHash } from "../src/lib/auth";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_ENV_FILE = join(REPO_ROOT, ".env");
/** External credentials file some hosts pass to the app via a supervisor's EnvironmentFile. */
const EXTERNAL_AUTH_ENV_FILE = "~/.config/healthvault/auth.env";

const PASSWORD_HASH_KEY = "HEALTHVAULT_PASSWORD_HASH";
const SESSION_SECRET_KEY = "HEALTHVAULT_SESSION_SECRET";
const API_TOKEN_KEY = "HEALTHVAULT_API_TOKEN";
const API_TOKEN_FILE_KEY = "HEALTHVAULT_API_TOKEN_FILE";
const DEFAULT_AGENT_TOKEN_FILE = "~/.config/healthvault/agent.token";

const USAGE = `Usage: bun scripts/password.ts <set|verify> [options]

Commands:
  set      set a new UI password (prompted twice, hidden) and write credentials
  verify   check a password against the stored hash

Options:
  --file <path>        env file to read/write (default: ~/.config/healthvault/auth.env when it
                       exists, otherwise ${DEFAULT_ENV_FILE})
  --token-file <path>  write the agent token to this owner-only file (default: ${DEFAULT_AGENT_TOKEN_FILE})
  -h, --help           show this help
`;

type Options = {
  command: string;
  file: string;
  /** Optional private file for the agent API token. */
  tokenFile?: string;
  help: boolean;
};

/**
 * Default env file. An existing external credentials file wins over the repo .env: a host may
 * run the app with a supervisor's EnvironmentFile, and real process env beats Next's .env, so
 * writing a shadow repo .env would be silently ignored.
 */
function defaultEnvFile(): string {
  const external = expandHomePath(EXTERNAL_AUTH_ENV_FILE);
  return existsSync(external) ? external : DEFAULT_ENV_FILE;
}

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  let command: string | undefined;
  let file: string | undefined;
  let tokenFile: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--file" || arg === "--token-file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        usageError(`error: ${arg} needs a path`);
      }
      i += 1;
      if (arg === "--file") file = value;
      else tokenFile = value;
    } else if (arg.startsWith("-")) {
      usageError(`error: unknown option ${arg}`);
    } else if (command === undefined) {
      command = arg;
    } else {
      usageError(`error: unexpected argument ${arg}`);
    }
  }

  if (command === undefined) {
    if (help) {
      console.log(USAGE);
      process.exit(0);
    }
    usageError("error: missing command");
  }
  if (command !== "set" && command !== "verify") {
    usageError(`error: unknown command ${command}`);
  }

  return {
    command,
    file: file ? resolve(file) : defaultEnvFile(),
    tokenFile,
    help,
  };
}

/**
 * Hidden-input prompter. readline writes its prompt/echo to the supplied output stream;
 * discarding that stream keeps the password off the terminal, while the prompt itself is
 * written to stderr so it is visible. Lines are queued rather than read with rl.question so
 * piped input that arrives in one chunk (all lines at once) cannot drop the second prompt.
 */
function createPrompter(): { ask(question: string): Promise<string>; close(): void } {
  const muted = new Writable({
    write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      callback();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: muted,
    terminal: process.stdin.isTTY === true,
  });
  const queued: string[] = [];
  let pending: Array<(line: string) => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    const next = pending.shift();
    if (next) next(line);
    else queued.push(line);
  });

  // EOF before every prompt was answered: settle the rest with an empty line.
  rl.once("close", () => {
    closed = true;
    const rest = pending;
    pending = [];
    for (const resolve of rest) resolve("");
  });

  rl.on("SIGINT", () => {
    process.stderr.write("\n");
    rl.close();
    process.exit(130);
  });

  return {
    ask(question: string): Promise<string> {
      process.stderr.write(question);
      return new Promise((resolveAnswer) => {
        const settle = (answer: string) => {
          process.stderr.write("\n");
          resolveAnswer(answer);
        };
        if (closed) {
          settle("");
          return;
        }
        const line = queued.shift();
        if (line !== undefined) {
          settle(line);
          return;
        }
        pending.push(settle);
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      rl.close();
      process.stdin.pause();
    },
  };
}

function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function envValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] === key) return match[2].trim();
  }
  return undefined;
}

/** Replace the first `KEY=` line, or append one, leaving every other line untouched. */
function upsertEnv(text: string, key: string, value: string): string {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const replacement = `${key}=${value}`;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) {
      lines[i] = replacement;
      return lines.join("\n");
    }
  }
  const base = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${replacement}\n`;
}

function removeEnvKey(text: string, key: string): string {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "i");
  return text
    .split("\n")
    .filter((line) => !pattern.test(line))
    .join("\n");
}

function ensurePrivateDir(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateFile(path: string, content: string): void {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

async function runSet(options: Options): Promise<void> {
  console.log(`target: ${options.file}`);
  const prompter = createPrompter();
  let password: string;
  let repeated: string;
  try {
    password = await prompter.ask("New password: ");
    repeated = await prompter.ask("Repeat password: ");
  } finally {
    prompter.close();
  }

  if (!password) {
    console.error("error: password must not be empty");
    process.exit(1);
  }
  if (password !== repeated) {
    console.error("error: passwords do not match");
    process.exit(1);
  }

  const existing = readTextIfPresent(options.file) ?? "";
  const hadPasswordHash = envValue(existing, PASSWORD_HASH_KEY) !== undefined;
  const hadSessionSecret = Boolean(envValue(existing, SESSION_SECRET_KEY));
  const configuredTokenFile = envValue(existing, API_TOKEN_FILE_KEY);
  const existingToken = envValue(existing, API_TOKEN_KEY);

  let content = upsertEnv(existing, PASSWORD_HASH_KEY, hashPassword(password));
  if (!hadSessionSecret) {
    content = upsertEnv(content, SESSION_SECRET_KEY, generateSecret());
  }

  const projectEnv = options.file === resolve(DEFAULT_ENV_FILE);
  const tokenFile = options.tokenFile
    ? resolve(expandHomePath(options.tokenFile))
    : configuredTokenFile
      ? resolve(expandHomePath(configuredTokenFile))
      : resolve(expandHomePath(DEFAULT_AGENT_TOKEN_FILE));
  let tokenEntry: string;
  if (options.tokenFile !== undefined || configuredTokenFile) {
    const shouldWriteToken = options.tokenFile !== undefined || !existsSync(tokenFile);
    if (shouldWriteToken) writePrivateFile(tokenFile, `${generateSecret()}\n`);
    content = removeEnvKey(content, API_TOKEN_KEY);
    content = upsertEnv(content, API_TOKEN_FILE_KEY, tokenFile);
    tokenEntry = `${shouldWriteToken ? "created/rotated" : "kept"} ${API_TOKEN_FILE_KEY} (${tokenFile})`;
  } else if (projectEnv) {
    const hadAgentToken = Boolean(existingToken);
    const token = existingToken || generateSecret();
    content = upsertEnv(content, API_TOKEN_KEY, token);
    writePrivateFile(tokenFile, `${token}\n`);
    tokenEntry = `${hadAgentToken ? "kept" : "created"} ${API_TOKEN_KEY}; synchronized private token file (${tokenFile})`;
  } else if (existingToken) {
    writePrivateFile(tokenFile, `${existingToken}\n`);
    tokenEntry = `kept ${API_TOKEN_KEY}; synchronized private token file (${tokenFile})`;
  } else {
    writePrivateFile(tokenFile, `${generateSecret()}\n`);
    content = removeEnvKey(content, API_TOKEN_KEY);
    content = upsertEnv(content, API_TOKEN_FILE_KEY, tokenFile);
    tokenEntry = `created ${API_TOKEN_FILE_KEY} (${tokenFile})`;
  }
  writePrivateFile(options.file, content);

  const entries = [`${hadPasswordHash ? "updated" : "created"} ${PASSWORD_HASH_KEY}`];
  if (!hadSessionSecret) entries.push(`created ${SESSION_SECRET_KEY}`);
  entries.push(tokenEntry);

  console.log(`wrote ${options.file} (mode 0600)`);
  for (const entry of entries) console.log(`  ${entry}`);
}

async function runVerify(options: Options): Promise<void> {
  console.log(`target: ${options.file}`);
  const text = readTextIfPresent(options.file) ?? "";
  const stored =
    envValue(text, PASSWORD_HASH_KEY) || process.env.HEALTHVAULT_PASSWORD_HASH?.trim();
  if (!stored) {
    console.error(
      `error: ${PASSWORD_HASH_KEY} is not set in ${options.file} or the environment; ` +
        "run `bun scripts/password.ts set` first",
    );
    process.exit(2);
  }

  const prompter = createPrompter();
  let password: string;
  try {
    password = await prompter.ask("Password: ");
  } finally {
    prompter.close();
  }

  if (!password) {
    console.error("error: password must not be empty");
    process.exit(1);
  }

  if (verifyPasswordHash(password, stored)) {
    console.log("password OK");
    process.exit(0);
  }
  console.error("password does NOT match");
  process.exit(1);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

if (options.command === "set") await runSet(options);
else await runVerify(options);
