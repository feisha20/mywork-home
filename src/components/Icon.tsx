interface IconProps {
  name: 'arrow' | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'check' | 'plus' | 'list' | 'book' | 'calendar' | 'close' | 'trash' | 'copy' | 'refresh' | 'settings' | 'model' | 'sources' | 'arrow-up' | 'arrow-down' | 'eye' | 'search' | 'upload' | 'grip' | 'clock'
  className?: string
}

const paths = {
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  'chevron-left': 'm15 18-6-6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-down': 'm6 9 6 6 6-6',
  check: 'm5 12 4 4L19 6',
  plus: 'M12 5v14M5 12h14',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  book: 'M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01',
  close: 'm6 6 12 12M6 18 18 6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  copy: 'M9 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2ZM16 4V3a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.55-1L20 9M4 15l2.35 3A7 7 0 0 0 17.9 17',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  model: 'M7 3h10v4h4v10h-4v4H7v-4H3V7h4V3ZM8 8h8v8H8V8Z',
  sources: 'm12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5',
  'arrow-up': 'M12 20V4m-6 6 6-6 6 6',
  'arrow-down': 'M12 4v16m-6-6 6 6 6-6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5',
  grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  clock: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10ZM12 6v6l4 2',
}

export function Icon({ name, className }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
