/**
 * The seed vocabulary.
 *
 * The reference implementation ships a hardcoded list of developer jargon and
 * pushes it to the recogniser before every session. That list is doing real
 * work: these are the words generic ASR gets wrong most often, and they cost
 * nothing to bias toward. This is the pi-flavoured equivalent.
 *
 * Every entry must survive `sanitizeKeyterms` (3-20 chars, ASCII, single token).
 */
export const SEED_KEYTERMS: readonly string[] = [
	// Cross-domain developer jargon, carried over from the reference list.
	"MCP",
	"symlink",
	"grep",
	"regex",
	"localhost",
	"codebase",
	"TypeScript",
	"JSON",
	"OAuth",
	"webhook",
	"gRPC",
	"dotfiles",
	"subagent",
	"worktree",
	// pi and its workflow vocabulary.
	"extension",
	"skill",
	"transcript",
	"codemode",
	"toolset",
	"settings",
	"prompt",
	"compaction",
	// Coding vocabulary that dictation reliably mangles.
	"stdin",
	"stdout",
	"stderr",
	"endpoint",
	"payload",
	"backend",
	"frontend",
	"refactor",
	"rebase",
	"monorepo",
	"lockfile",
	"boolean",
	"integer",
	"tsconfig",
	"eslint",
	"biome",
	"vitest",
	"runtime",
	"parser",
	"schema",
	"migration",
	"deprecated",
	"idempotent",
];
