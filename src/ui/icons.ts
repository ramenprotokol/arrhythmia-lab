// Line icons for the page, as inline SVG strings. Decorative: every button that shows one has its own name.
const stroke = (size: number, body: string, width = 1.8): string =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const filled = (size: number, body: string): string =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  soundOff: (s = 22) => stroke(s, '<path d="M11 5 6.5 9H3v6h3.5L11 19V5z"/><path d="m16 9.5 5 5"/><path d="m21 9.5-5 5"/>'),
  soundOn: (s = 22) => stroke(s, '<path d="M11 5 6.5 9H3v6h3.5L11 19V5z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>'),
  labels: (s = 22) => stroke(s, '<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1.3"/>'),
  cut: (s = 22) => stroke(s, '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 18"/><path d="M8 16.5 20 6"/>'),
  record: (s = 22) => stroke(s, '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>'),
  stop: (s = 22) => stroke(s, '<circle cx="12" cy="12" r="7.5"/><rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1" fill="currentColor"/>'),
  help: (s = 22) => stroke(s, '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.8.4-1.1.9-1.1 1.8"/><circle cx="12" cy="17" r=".8" fill="currentColor"/>'),
  more: (s = 22) => filled(s, '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>'),
  close: (s = 18) => stroke(s, '<path d="M6 6l12 12M18 6 6 18"/>', 2),
  bolt: (s = 20) => filled(s, '<path d="M13 2 5 13.5h6L10 22l9-12h-6.5L13 2z"/>'),
  warn: (s = 14) => filled(s, '<path d="M12 3 2.5 20h19L12 3z"/>'),
  diamond: (s = 12) => filled(s, '<path d="M12 2 22 12 12 22 2 12z"/>'),
  clock: (s = 13) => stroke(s, '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>', 2.4),
  check: (s = 14) => stroke(s, '<path d="m5 12.5 4.5 4.5L19 7.5"/>', 3),
  chevron: (s = 14) => stroke(s, '<path d="m6 9 6 6 6-6"/>', 2.4),
  lessons: (s = 20) => stroke(s, '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>'),
  explore: (s = 20) => stroke(s, '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  back: (s = 16) => stroke(s, '<path d="M15 6l-6 6 6 6"/>', 2.2),
};
