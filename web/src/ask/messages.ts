import type { AskErrorKind } from './askStore';

export function askErrorMessage(kind: AskErrorKind, origin: string | null, status?: number): string {
  switch (kind) {
    case 'setup':
      return 'Set up Ask in Settings.';
    case 'retrieval':
      return 'Couldn’t search your notes.';
    case 'auth':
      return 'Your API key was rejected. Check Settings.';
    case 'rate':
      return 'The provider is rate limiting. Try again shortly.';
    case 'network':
      return `Couldn’t reach ${origin ?? 'the provider'}.`;
    case 'http':
      return status ? `The provider returned an error (${status}).` : 'The provider returned an error.';
    case 'cut':
      return 'Answer cut off.';
  }
}
