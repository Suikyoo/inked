import type { AccountSettingsState } from '../state/accountSettings';
import { useAccountSettings } from '../state/AccountSettingsContext';
import { useSemantic, useSemanticStore } from '../semantic/SemanticContext';
import type { SemanticState } from '../semantic/semanticStore';

export function modelBannerKind(
  sem: Pick<SemanticState, 'available' | 'accountOn' | 'choice'>,
  account: Pick<AccountSettingsState, 'loaded' | 'settings'>,
): 'semantic' | 'ask' | null {
  if (sem.available !== true || !account.loaded || sem.choice !== null) return null;
  if (sem.accountOn) return 'semantic';
  return account.settings.llm ? 'ask' : null;
}

/** Persistent until this browser chooses: download the search model here, or not. */
export function ModelBanner() {
  const sem = useSemantic();
  const semantic = useSemanticStore();
  const account = useAccountSettings();
  const kind = modelBannerKind(sem, account);
  if (!kind) return null;
  const mb = sem.downloadBytes === null ? '' : ` ${Math.round(sem.downloadBytes / 1e6)} MB`;
  const lead =
    kind === 'semantic' ? 'Search by meaning is on for your account.' : 'Ask finds better sources with search by meaning.';
  return (
    <div className="model-bar" role="status">
      <span>
        {lead} This browser needs a one-time{mb} download.
      </span>
      <span className="model-bar-actions">
        <button type="button" className="model-bar-btn" onClick={() => void semantic.downloadHere().catch(() => undefined)}>
          Download
        </button>
        <button type="button" className="model-bar-btn is-quiet" onClick={() => semantic.declineHere()}>
          Not on this browser
        </button>
      </span>
    </div>
  );
}
