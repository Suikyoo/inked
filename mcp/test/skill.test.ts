import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/tools';

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(path.join(here, '../plugin/skills/inked-notes/SKILL.md'), 'utf8');

describe('inked-notes skill', () => {
  it('has name and description front matter', () => {
    expect(skill).toMatch(/^---\r?\nname: inked-notes\r?\ndescription: .+\r?\n---\r?\n/);
  });

  it('names only tools that exist', () => {
    const named = new Set(skill.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
    const toolLike = [...named].filter((n) => /^(list|get|read|search|create|append|update|move|rename|delete)_/.test(n));
    for (const n of toolLike) expect(TOOL_NAMES).toContain(n);
  });

  it('mentions every tool at least once', () => {
    for (const n of TOOL_NAMES) expect(skill).toContain(n);
  });
});
