import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root, so paths work no matter which directory the process starts in
 *  (the MCP server is launched by Claude Desktop from its own cwd). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// quiet: the MCP server talks JSON-RPC over stdout, so nothing else may print there.
dotenv.config({ path: resolve(ROOT, '.env'), quiet: true });

export type Provider = 'google' | 'openai' | 'anthropic';

/** Default model pair per provider: a strong "main" model for answers and
 *  claim comparison, and a cheap "fast" model for routing and extraction. */
const DEFAULT_MODELS: Record<Provider, { main: string; fast: string }> = {
  google: { main: 'gemini-3.8-flash', fast: 'gemini-flash-lite-latest' },
  openai: { main: 'gpt-5.5', fast: 'gpt-5.4-mini' },
  anthropic: { main: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5' },
};

const KEY_ENV: Record<Provider, string> = {
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Use LLM_PROVIDER if set; otherwise pick whichever provider has a key. */
function detectProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === 'google' || explicit === 'openai' || explicit === 'anthropic') return explicit;
  for (const p of ['google', 'openai', 'anthropic'] as const) {
    if (process.env[KEY_ENV[p]]) return p;
  }
  return 'google';
}

const provider = detectProvider();

export const config = {
  provider,
  providerKeyEnv: KEY_ENV[provider],
  hasLlmKey: Boolean(process.env[KEY_ENV[provider]]),
  mainModel: process.env.MAIN_MODEL || DEFAULT_MODELS[provider].main,
  fastModel: process.env.FAST_MODEL || DEFAULT_MODELS[provider].fast,
  tavilyKey: process.env.TAVILY_API_KEY ?? '',
  port: Number(process.env.PORT ?? 3000),
  dataFile: resolve(ROOT, process.env.MEMORY_FILE ?? 'data/memory.json'),
  defaultTimezone:
    process.env.DEFAULT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  /** Lets the UI/seed script set the agent's clock to test "last Tuesday"-style questions. */
  allowTimeTravel: process.env.ALLOW_TIME_TRAVEL !== 'false',
};
