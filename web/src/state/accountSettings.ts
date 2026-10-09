import type { AccountSettings } from 'inked-core';
import { api, isApiError } from '../api/client';
import type { AppStore } from './store';

export interface AccountSettingsState {
  /** True once this unlock has read (or failed to read) the settings. */
  loaded: boolean;
  settings: AccountSettings;
  /** The stored settings did not decrypt; they count as unset until saved again. */
  unreadable: boolean;
  /** Provider origins this deployment allows for Ask; empty hides Ask. */
  llmOrigins: string[];
}

export interface AccountSettingsDeps {
  api: Pick<typeof api, 'status' | 'getSettings' | 'putSettings'>;
}

type AppLike = Pick<AppStore, 'getState' | 'subscribe' | 'encryptAccountSettings' | 'decryptAccountSettings'>;

const EMPTY: AccountSettingsState = { loaded: false, settings: {}, unreadable: false, llmOrigins: [] };

/** The synced, encrypted account settings: read after unlock, saved by read-merge-write, dropped on lock. */
export class AccountSettingsStore {
  private state = EMPTY;
  private listeners = new Set<() => void>();
  private deps: AccountSettingsDeps;
  private unlocked = false;
  private epoch = 0;
  private updatedAt: string | null = null;
  private unsubscribe: () => void;

  constructor(
    private app: AppLike,
    deps: Partial<AccountSettingsDeps> = {},
  ) {
    this.deps = { api, ...deps };
    this.unsubscribe = app.subscribe(this.onApp);
    this.onApp();
  }

  getState = (): AccountSettingsState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<AccountSettingsState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private onApp = () => {
    const s = this.app.getState();
    const unlocked = s.phase === 'unlocked' && !s.locking;
    if (unlocked === this.unlocked) return;
    this.unlocked = unlocked;
    this.epoch++;
    this.updatedAt = null;
    this.set(EMPTY);
    if (unlocked) void this.load(this.epoch);
  };

  private async read(): Promise<{ settings: AccountSettings; unreadable: boolean }> {
    const { encSettings, updatedAt } = await this.deps.api.getSettings();
    this.updatedAt = updatedAt;
    if (!encSettings) return { settings: {}, unreadable: false };
    try {
      return { settings: await this.app.decryptAccountSettings(encSettings), unreadable: false };
    } catch {
      return { settings: {}, unreadable: true };
    }
  }

  private async load(ep: number) {
    const [status, read] = await Promise.all([
      this.deps.api.status().catch(() => ({ llmOrigins: [] as string[] })),
      this.read().catch(() => ({ settings: {} as AccountSettings, unreadable: false })),
    ]);
    if (ep !== this.epoch) return;
    this.set({ loaded: true, settings: read.settings, unreadable: read.unreadable, llmOrigins: status.llmOrigins ?? [] });
  }

  /** Applies `change` to the current settings and saves; on 409 re-reads, applies it again and retries once. */
  async update(change: (s: AccountSettings) => AccountSettings): Promise<void> {
    const ep = this.epoch;
    let base = this.state.settings;
    for (let attempt = 0; ; attempt++) {
      const next = change(base);
      const encSettings = await this.app.encryptAccountSettings(next);
      try {
        const { updatedAt } = await this.deps.api.putSettings({ encSettings, baseUpdatedAt: this.updatedAt });
        if (ep !== this.epoch) return;
        this.updatedAt = updatedAt;
        this.set({ settings: next, unreadable: false });
        return;
      } catch (e) {
        if (!(isApiError(e, 409) && e.code === 'conflict') || attempt >= 1 || ep !== this.epoch) throw e;
        base = (await this.read()).settings;
        if (ep !== this.epoch) return;
      }
    }
  }
}
