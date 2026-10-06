const KEY = 'inked.spellcheck';

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
};
