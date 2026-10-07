import { prefersReducedMotion } from './reducedMotion';

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

/** Runs `update` inside a View Transition when supported and motion is allowed, else directly. */
export function withViewTransition(update: () => void): void {
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
    doc.startViewTransition(update);
    return;
  }
  update();
}
