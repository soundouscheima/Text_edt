/* ============================================================
   icons.js — inline SVG icon set as exported strings.
   Pure dependency-free; icons that imply horizontal direction
   (arrows) get mirrored in RTL via CSS .ai-mirror.
   ============================================================ */

const stroke = (d, extra = '') =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${extra}<path d="${d}"/></svg>`;

export const icons = {
  plus: stroke('M12 5v14M5 12h14'),
  open: stroke('M4 19V5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5z'),
  download: stroke('M12 3v13m0 0 4-4m-4 4-4-4M5 21h14'),
  undo: stroke('M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12'),
  redo: stroke('M16 5l5 5-5 5M21 10H10a6 6 0 0 0 0 12'),
  zoomIn: stroke('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35M11 8v6M8 11h6'),
  zoomOut: stroke('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35M8 11h6'),
  wrap: stroke('M3 6h18M3 12h13a3 3 0 0 1 0 6h-4M12 15l-2 3 2 3'),
  find: stroke('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35'),
  outline: stroke('M4 6h9M4 12h9M4 18h9M17 6h3M17 12h3M17 18h3'),
  preview: stroke('M9 6h11M9 12h11M9 18h11M5 4v2M5 10v2M5 16v2'),
  focusMode: stroke('M5 5h6v2H7v4H5V5zM19 5h-6v2h4v4h2V5zM5 19h6v-2H7v-4H5v6zM19 19h-6v-2h4v-4h2v6z'),
  help: stroke('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 15v.01M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5'),
  spark: stroke('M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z'),
  settings: stroke('M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1l2.1-2.1M17 7l2.1-2.1'),
  close: stroke('M6 6l12 12M18 6L6 18'),
  send: stroke('M3 12l18-9-3 18-6-6-7 5 5-10-7-2 9-3z'),
  trash: stroke('M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3'),
  copy: stroke('M9 9h11v11H9zM5 15H4V4h11v1'),
  check: stroke('M5 13l4 4L19 7'),
  chevronLeft: stroke('M15 5l-7 7 7 7'),
  chevronRight: stroke('M9 5l7 7-7 7'),
  chevronUp: stroke('M5 15l7-7 7 7'),
  chevronDown: stroke('M5 9l7 7 7-7'),
  document: stroke('M7 3h7l5 5v13H7zM14 3v5h5'),
  search: stroke('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35'),
  replace: stroke('M4 6h11a4 4 0 0 1 0 8H4m0-8 2-2m-2 2 2 2M10 22h10M16 6l3-3 3 3M19 3v19'),
  cases: stroke('M9 10h6m-6 4h6M7 20 17 4M5 8h4M15 8h4M3 12h3M18 12h3'),
  regex: stroke('M6 3v18M18 3v18M3 6h12v12H3z'),
  wholeWord: stroke('M5 8h14M5 16h14M2 12h20'),
  wordCount: stroke('M4 6h16M4 12h16M4 18h16'),
  punctuation: stroke('M8 5h8M8 12h8M12 5v14'),
  ai: stroke('M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z'),
  emptyDoc: stroke('M9 3h6l6 6v12H3V3zM14 3v6h6'),
  book: stroke('M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5'),
  sparkStroke: stroke('M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z'),
  warning: stroke('M12 3 2 21h20L12 3zM12 9v5M12 17.5v.5'),
  refresh: stroke('M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6'),
  plug: stroke('M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5'),
  globe: stroke('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18'),
};

export function svgFor(name, cls = 'ic') {
  const s = icons[name];
  if (!s) return '';
  return s; // already a full <svg> string
}

export default icons;