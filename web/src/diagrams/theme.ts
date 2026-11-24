import type { DiagramTheme } from './protocol';

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Inked's colors for Mermaid, read from the CSS variables. Mermaid does colour maths on these, so they must be
 * literal colors, not var(). The app is dark-only; if a light theme is added, the cache key must include the theme.
 */
export function readDiagramTheme(): DiagramTheme {
  return {
    darkMode: true,
    background: cssVar('--panel', '#1b1822'),
    fontFamily: cssVar('--font-ui', "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"),
    fontSize: '14px',
    textColor: cssVar('--text', '#e9e4f0'),
    primaryColor: cssVar('--panel-3', '#2b2636'),
    primaryTextColor: cssVar('--text', '#e9e4f0'),
    primaryBorderColor: cssVar('--ink', '#7150bf'),
    secondaryColor: cssVar('--panel-2', '#231f2c'),
    tertiaryColor: cssVar('--side', '#100e16'),
    lineColor: cssVar('--ink-link', '#a99aba'),
    noteBkgColor: cssVar('--panel-2', '#231f2c'),
    noteTextColor: cssVar('--text', '#e9e4f0'),
    noteBorderColor: cssVar('--border-2', '#484052'),
  };
}
