const KEY = 'inked.spellcheck';
const SEMANTIC_KEY = 'inked.semantic';

export type SemanticChoice = 'on' | 'off' | null;

export const prefs = {
  spellcheck(): boolean {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  },
  setSpellcheck(on: boolean): void {
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* storage blocked: keep default */
    }
  },
  /** This browser's model choice: on (downloaded here), off (declined here) or null (not asked yet). */
  semanticChoice(): SemanticChoice {
    try {
      const v = localStorage.getItem(SEMANTIC_KEY);
      // Round 4 stored '1' (on) and '0' (off for this device, which did not mean "declined").
      return v === 'on' || v === '1' ? 'on' : v === 'off' ? 'off' : null;
    } catch {
      return null;
    }
  },
  setSemanticChoice(v: SemanticChoice): void {
    try {
      if (v === null) localStorage.removeItem(SEMANTIC_KEY);
      else localStorage.setItem(SEMANTIC_KEY, v);
    } catch {
      /* storage blocked: keep default */
    }
  },
};
