/**
 * The five built-in icons, on their own so that a parser can draw them.
 *
 * `icons.ts` holds these beside the loaders for the bundled collections, and
 * importing anything from there pulls the collections in behind it — which
 * is why what the parser needs was moved out of it once already.
 */

/**
 * mermaid architecture-beta's five built-in icon names, drawn as minimal
 * inline SVGs so the canvas needs no icon pack for plain diagrams.
 */
export const BUILTIN: Record<string, string> = {
  server:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="7" cy="7.5" r="0.9" fill="currentColor"/><circle cx="7" cy="16.5" r="0.9" fill="currentColor"/></svg>',
  database:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  disk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/></svg>',
  cloud:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 18a4.5 4.5 0 1 1 .8-8.9A6 6 0 0 1 19.5 11 3.5 3.5 0 0 1 18.5 18Z"/></svg>',
  internet:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9s1.5-6.6 4-9Z"/></svg>',
};
