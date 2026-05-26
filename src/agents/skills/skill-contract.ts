import { createHash } from "node:crypto";
import type { Skill as CanonicalSkill, SourceInfo } from "@mariozechner/pi-coding-agent";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export type Skill = CanonicalSkill & {
  // Preserve legacy source reads while keeping the canonical upstream shape.
  source?: string;
};

export function createSyntheticSourceInfo(
  path: string,
  options: {
    source: string;
    scope?: SourceScope;
    origin?: SourceOrigin;
    baseDir?: string;
  },
): SourceInfo {
  return {
    path,
    source: options.source,
    scope: options.scope ?? "temporary",
    origin: options.origin ?? "top-level",
    baseDir: options.baseDir,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Formatter output cache
//
// The two skill prompt formatters in this file (and the `formatSkillsCompact`
// helper in workspace.ts that delegates here via `cachedFormatSkillsCompact`)
// are invoked on every session prompt rebuild, every subagent spawn, and every
// snapshot recomputation. Each call appends ~24 entries (~25 KB total) into a
// freshly-allocated string. In a long-running daemon those strings accumulate
// as distinct heap allocations even when the underlying skill set has not
// changed, because every caller passes either a fresh sorted array clone or a
// new session-scoped wrapper.
//
// We cache by a fingerprint of the skill identities (name + filePath +
// description length) so that callers that pass equivalent skill sets reuse
// the same string reference. Skill arrays are normalized (sorted by name)
// before fingerprinting so callers do not have to pre-sort to hit the cache.
//
// The cache is module-scoped (intentionally) so all sessions in the same
// daemon process share entries. Capacity is small (`SKILL_FORMATTER_CACHE_MAX`)
// because each entry holds a ~25 KB string and we only need enough slots to
// cover the handful of distinct skill set shapes that exist concurrently
// (different filters / different sources). The empty-list fast path is kept
// outside the cache.
//
// NOTE (2026.4.15 backport): The upstream/main version of this file imports
// `PluginLruCache` from `../../plugins/plugin-cache-primitives.js`. That
// primitive does not exist on the v2026.4.15 base, so we inline a minimal
// LRU implementation here that mirrors the subset of the upstream API we
// actually use (get / set / size / clear). No new module dependency.
// ---------------------------------------------------------------------------

const SKILL_FORMATTER_CACHE_MAX = 32;

type SkillFormatterVariant = "full" | "compact";

class InlineLruCache<T> {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, T>();

  constructor(maxEntries: number) {
    // Defensive normalization: clamp to >= 1 to avoid pathological 0/negative
    // values silently disabling the cache.
    this.#maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  get(cacheKey: string): T | undefined {
    if (!this.#entries.has(cacheKey)) {
      return undefined;
    }
    const cached = this.#entries.get(cacheKey) as T;
    // Move-to-end so most-recently-used stays alive.
    this.#entries.delete(cacheKey);
    this.#entries.set(cacheKey, cached);
    return cached;
  }

  set(cacheKey: string, value: T): void {
    if (this.#entries.has(cacheKey)) {
      this.#entries.delete(cacheKey);
    }
    this.#entries.set(cacheKey, value);
    while (this.#entries.size > this.#maxEntries) {
      const oldestEntry = this.#entries.keys().next();
      if (oldestEntry.done) {
        break;
      }
      this.#entries.delete(oldestEntry.value);
    }
  }
}

const formatterOutputCache = new InlineLruCache<string>(SKILL_FORMATTER_CACHE_MAX);

/**
 * Build a stable fingerprint for an arbitrary list of skills under a given
 * formatter variant. Skill identity uses `name + filePath + description
 * length`: name+filePath uniquely identifies a skill, and including
 * description length lets the fingerprint mismatch whenever a skill's
 * description text changes (the length is cheap to read and changes when any
 * single character is added/removed). The skills are sorted by name+filePath
 * inside this helper so callers that pass equivalent sets in different orders
 * still hit the same cache entry.
 *
 * Exported for tests and so workspace.ts can reuse the same cache for its
 * compact-formatter variant without re-importing the cache instance itself.
 */
export function buildSkillFormatterFingerprint(
  skills: ReadonlyArray<Pick<Skill, "name" | "filePath" | "description">>,
  variant: SkillFormatterVariant,
): string {
  const hash = createHash("sha256");
  hash.update(variant);
  hash.update("\u0001");
  // Sort by (name, filePath) so insertion order does not affect the key.
  const sorted = [...skills].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
  });
  for (const skill of sorted) {
    hash.update(skill.name);
    hash.update("\u0000");
    hash.update(skill.filePath);
    hash.update("\u0000");
    hash.update(String((skill.description ?? "").length));
    hash.update("\u0002");
  }
  return hash.digest("hex");
}

/**
 * Test-only hook: reset the formatter output cache so tests can exercise
 * eviction / cold-miss behavior without leaking state across cases.
 */
export function __resetSkillFormatterCacheForTest(): void {
  formatterOutputCache.clear();
}

/**
 * Test-only hook: inspect the formatter output cache size.
 */
export function __skillFormatterCacheSizeForTest(): number {
  return formatterOutputCache.size;
}

function buildFullSkillsPrompt(skills: ReadonlyArray<Skill>): string {
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/**
 * Keep this formatter's XML layout byte-for-byte aligned with the upstream
 * Agent Skills formatter so we can avoid importing the full pi-coding-agent
 * package root on the cold skills path. Visibility policy is applied upstream
 * before calling this helper.
 *
 * Output is cached by skills-set fingerprint so repeated invocations across
 * sessions reuse the same string reference. See the cache block above for
 * rationale and capacity tuning.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return "";
  }
  const cacheKey = buildSkillFormatterFingerprint(skills, "full");
  const cached = formatterOutputCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const rendered = buildFullSkillsPrompt(skills);
  formatterOutputCache.set(cacheKey, rendered);
  return rendered;
}

/**
 * Memoized variant for workspace.ts's compact formatter. Workspace.ts owns the
 * compact rendering itself (it emits a different XML shape — name+location
 * only); this helper just adds the same cache wrapper so both formatters share
 * the singleton LRU and benefit equally from skill-set deduplication.
 *
 * Caller passes a `render` thunk that performs the actual compact rendering
 * on a cache miss. We do not own the render shape because the compact format
 * has its own intro text/tests.
 */
export function cachedFormatSkillsCompact(
  skills: Skill[],
  render: (skills: Skill[]) => string,
): string {
  if (skills.length === 0) {
    return "";
  }
  const cacheKey = buildSkillFormatterFingerprint(skills, "compact");
  const cached = formatterOutputCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const rendered = render(skills);
  formatterOutputCache.set(cacheKey, rendered);
  return rendered;
}
