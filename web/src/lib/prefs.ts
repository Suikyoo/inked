const KEY = 'inked.spellcheck';
const SEMANTIC_KEY = 'inked.semantic';

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
  semantic(): boolean {
    try {
      return localStorage.getItem(SEMANTIC_KEY) === '1';
    } catch {
      return false;
    }
  },
  setSemantic(on: boolean): void {
    try {
      localStorage.setItem(SEMANTIC_KEY, on ? '1' : '0');
    } catch {
      /* storage blocked: keep default */
    }
  },
};
