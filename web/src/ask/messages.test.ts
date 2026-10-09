import { describe, expect, it } from 'vitest';
import { askErrorMessage } from './messages';

describe('askErrorMessage', () => {
  it('maps every kind', () => {
    expect(askErrorMessage('setup', null)).toBe('Set up Ask in Settings.');
    expect(askErrorMessage('retrieval', null)).toBe('Couldn’t search your notes.');
    expect(askErrorMessage('auth', null)).toBe('Your API key was rejected. Check Settings.');
    expect(askErrorMessage('rate', null)).toBe('The provider is rate limiting. Try again shortly.');
    expect(askErrorMessage('network', 'https://api.openai.com')).toBe('Couldn’t reach https://api.openai.com.');
    expect(askErrorMessage('network', null)).toBe('Couldn’t reach the provider.');
    expect(askErrorMessage('http', null, 500)).toBe('The provider returned an error (500).');
    expect(askErrorMessage('http', null)).toBe('The provider returned an error.');
    expect(askErrorMessage('cut', null)).toBe('Answer cut off.');
  });
});
