/** Where the unlock ink-wipe spreads from (viewport px). Read by the ::view-transition-new(root) keyframes. */
export function setWipeOrigin(x: number, y: number): void {
  const s = document.documentElement.style;
  s.setProperty('--wipe-x', `${Math.round(x)}px`);
  s.setProperty('--wipe-y', `${Math.round(y)}px`);
}
