import { prefersReducedMotion } from './reducedMotion';

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished?: Promise<unknown> } | undefined };

/** Runs `update` inside a View Transition when supported and motion is allowed, else directly. */
export function withViewTransition(update: () => void): { finished?: Promise<unknown> } | undefined {
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
    return doc.startViewTransition(update);
  }
  update();
  return undefined;
}
