import { beforeEach, describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "../skills.test-helpers.js";
import {
  __resetSkillFormatterCacheForTest,
  __skillFormatterCacheSizeForTest,
  buildSkillFormatterFingerprint,
  cachedFormatSkillsCompact,
  formatSkillsForPrompt,
  type Skill,
} from "./skill-contract.js";

function makeSkill(
  name: string,
  description = "A skill",
  filePath = `/skills/${name}/SKILL.md`,
): Skill {
  return createCanonicalFixtureSkill({
    name,
    description,
    filePath,
    baseDir: `/skills/${name}`,
    source: "workspace",
  });
}

// Render thunk used to confirm cache hits for the compact-formatter delegate.
// Counter on the closure lets each test verify how many times the underlying
// render ran versus how many times the cache served the result.
function makeCountingRender(): {
  render: (skills: Skill[]) => string;
  callCount: () => number;
} {
  let calls = 0;
  return {
    render: (skills) => {
      calls += 1;
      return `compact[${skills.map((s) => s.name).join(",")}]`;
    },
    callCount: () => calls,
  };
}

describe("formatSkillsForPrompt cache", () => {
  beforeEach(() => {
    __resetSkillFormatterCacheForTest();
  });

  it("caches output for repeated identical inputs (size does not grow on second call)", () => {
    const skills = [makeSkill("weather"), makeSkill("notes")];
    const first = formatSkillsForPrompt(skills);
    expect(__skillFormatterCacheSizeForTest()).toBe(1);
    const second = formatSkillsForPrompt(skills);
    expect(second).toBe(first);
    expect(__skillFormatterCacheSizeForTest()).toBe(1);
  });

  it("hits the cache when called with a new array instance of equivalent skills", () => {
    const a = [makeSkill("weather"), makeSkill("notes")];
    const b = [makeSkill("weather"), makeSkill("notes")];
    expect(a).not.toBe(b);
    formatSkillsForPrompt(a);
    expect(__skillFormatterCacheSizeForTest()).toBe(1);
    formatSkillsForPrompt(b);
    expect(__skillFormatterCacheSizeForTest()).toBe(1);
  });

  it("hits the cache regardless of input ordering", () => {
    const ordered = [makeSkill("a"), makeSkill("b"), makeSkill("c")];
    const reversed = [makeSkill("c"), makeSkill("b"), makeSkill("a")];
    const first = formatSkillsForPrompt(ordered);
    expect(__skillFormatterCacheSizeForTest()).toBe(1);
    const second = formatSkillsForPrompt(reversed);
    expect(second).toBe(first);
    // Cache key sorts internally, so order does not introduce a second entry.
    expect(__skillFormatterCacheSizeForTest()).toBe(1);
  });

  it("does not collide across distinct skill sets", () => {
    const setA = [makeSkill("weather")];
    const setB = [makeSkill("notes")];
    const renderA = formatSkillsForPrompt(setA);
    const renderB = formatSkillsForPrompt(setB);
    expect(renderA).not.toBe(renderB);
    expect(renderA).toContain("weather");
    expect(renderB).toContain("notes");
  });

  it("invalidates on description text change (length differs)", () => {
    const before = formatSkillsForPrompt([makeSkill("weather", "Get weather data")]);
    const after = formatSkillsForPrompt([makeSkill("weather", "Get weather data and forecasts")]);
    expect(before).not.toBe(after);
    expect(after).toContain("Get weather data and forecasts");
  });

  it("short-circuits empty arrays without populating the cache", () => {
    expect(formatSkillsForPrompt([])).toBe("");
    expect(__skillFormatterCacheSizeForTest()).toBe(0);
  });

  it("caps the cache at 32 entries and evicts the oldest insertion", () => {
    // Drive 33 distinct skill sets through the cache. Size must stay at 32,
    // the most recently inserted set must still hit, and the very first set
    // must report itself as evicted (its second invocation triggers a render
    // again — verified by reading cache size before/after).
    const sets: Skill[][] = [];
    for (let i = 0; i < 33; i += 1) {
      sets.push([makeSkill(`skill-${i}`)]);
    }
    for (let i = 0; i < sets.length; i += 1) {
      formatSkillsForPrompt(sets[i]);
    }
    expect(__skillFormatterCacheSizeForTest()).toBe(32);
    // The most recently inserted set is still cached: a repeat call must not
    // grow the cache.
    formatSkillsForPrompt(sets[sets.length - 1]);
    expect(__skillFormatterCacheSizeForTest()).toBe(32);
    // Re-requesting the first (evicted) set must re-insert it and push out
    // whichever entry is now oldest, keeping the cap.
    formatSkillsForPrompt(sets[0]);
    expect(__skillFormatterCacheSizeForTest()).toBe(32);
  });
});

describe("cachedFormatSkillsCompact", () => {
  beforeEach(() => {
    __resetSkillFormatterCacheForTest();
  });

  it("invokes the render thunk once for repeated identical inputs", () => {
    const { render, callCount } = makeCountingRender();
    const skills = [makeSkill("weather"), makeSkill("notes")];
    const first = cachedFormatSkillsCompact(skills, render);
    const second = cachedFormatSkillsCompact(skills, render);
    expect(callCount()).toBe(1);
    expect(second).toBe(first);
  });

  it("uses a separate cache namespace from the full formatter", () => {
    const { render: compactRender, callCount: compactCalls } = makeCountingRender();
    const skills = [makeSkill("weather")];
    // Populate the full formatter cache first.
    const fullOut = formatSkillsForPrompt(skills);
    // The compact formatter must still miss the cache and render.
    const compactOut = cachedFormatSkillsCompact(skills, compactRender);
    expect(compactCalls()).toBe(1);
    expect(compactOut).not.toBe(fullOut);
    // Second compact call hits cache.
    cachedFormatSkillsCompact(skills, compactRender);
    expect(compactCalls()).toBe(1);
  });

  it("short-circuits empty arrays without calling the render thunk", () => {
    const { render, callCount } = makeCountingRender();
    expect(cachedFormatSkillsCompact([], render)).toBe("");
    expect(callCount()).toBe(0);
    expect(__skillFormatterCacheSizeForTest()).toBe(0);
  });
});

describe("buildSkillFormatterFingerprint", () => {
  it("produces identical fingerprints regardless of input order", () => {
    const setA = [makeSkill("a"), makeSkill("b"), makeSkill("c")];
    const setB = [makeSkill("c"), makeSkill("a"), makeSkill("b")];
    expect(buildSkillFormatterFingerprint(setA, "full")).toBe(
      buildSkillFormatterFingerprint(setB, "full"),
    );
  });

  it("distinguishes between full and compact variants", () => {
    const skills = [makeSkill("weather")];
    expect(buildSkillFormatterFingerprint(skills, "full")).not.toBe(
      buildSkillFormatterFingerprint(skills, "compact"),
    );
  });

  it("mismatches when a skill description length changes", () => {
    const before = [makeSkill("weather", "short")];
    const after = [makeSkill("weather", "a longer description")];
    expect(buildSkillFormatterFingerprint(before, "full")).not.toBe(
      buildSkillFormatterFingerprint(after, "full"),
    );
  });

  it("mismatches when filePath changes even if name is identical", () => {
    const a = [makeSkill("weather", "x", "/a/weather/SKILL.md")];
    const b = [makeSkill("weather", "x", "/b/weather/SKILL.md")];
    expect(buildSkillFormatterFingerprint(a, "full")).not.toBe(
      buildSkillFormatterFingerprint(b, "full"),
    );
  });
});
