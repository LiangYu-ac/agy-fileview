function svg(body: string, size = 15, extraAttr = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ${extraAttr}>${body}</svg>`;
}

export const ICONS = {
  chevron: svg('<path d="M6 4l4 4-4 4"/>', 13),
  newFile: svg('<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2z"/><path d="M9 2v4h4"/><path d="M8 8.5v3M6.5 10h3"/>', 15),
  newFolder: svg('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.3 1.5h4.7A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z"/><path d="M8 7.5v3M6.5 9h3"/>', 15),
  reveal: svg('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.3 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7z"/><circle cx="10.5" cy="9.5" r="2.2"/><path d="M12.2 11.2L14 13"/>', 15),
  terminal: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 6.5l2.2 1.8-2.2 1.8"/><path d="M8.2 10.2h3.2"/>', 15),
  eye: svg('<path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4z"/><circle cx="8" cy="8" r="1.8"/>', 15),
  sort: svg('<path d="M4.5 3v10M4.5 13l-2-2M4.5 13l2-2"/><path d="M11.5 13V3M11.5 3l-2 2M11.5 3l2 2"/>', 15),
  refresh: svg('<path d="M13.2 7A5.2 5.2 0 1 0 12 11.2"/><path d="M13.5 3.5V7H10"/>', 15),
  up: svg('<path d="M8 12.5V3.5M8 3.5L4.5 7M8 3.5L11.5 7"/>', 14),
  copy: svg('<rect x="5.5" y="5.5" width="7.5" height="8" rx="1.2"/><path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H4.3A1.3 1.3 0 0 0 3 3.8v6.9A1.3 1.3 0 0 0 4.3 12h1.2"/>', 14),
  jump: svg('<path d="M3 8h9.5M9 4.5L12.5 8 9 11.5"/>', 14),
  search: svg('<circle cx="7" cy="7" r="4.3"/><path d="M10.5 10.5L13.5 13.5"/>', 13),
  more: svg('<circle cx="4" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/>', 14),
  openPane: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M9 2.5v11"/>', 14),
  openExternal: svg('<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L7.5 8.5"/><path d="M6.5 3.5H3.8A1.3 1.3 0 0 0 2.5 4.8v7.4a1.3 1.3 0 0 0 1.3 1.3h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5"/>', 14),
  chat: svg('<path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H6l-3 2.5V4z"/>', 14),
  edit: svg('<path d="M10.8 2.7l2.5 2.5-7.6 7.6H3.2v-2.5l7.6-7.6z"/>', 14),
  cut: svg('<circle cx="4.5" cy="11.5" r="1.8"/><circle cx="11.5" cy="11.5" r="1.8"/><path d="M5.8 10.2L11.5 3M10.2 10.2L4.5 3"/>', 14),
  paste: svg('<rect x="4" y="3.5" width="8" height="10" rx="1.2"/><path d="M6.2 3.5V2.5h3.6v1"/>', 14),
  trash: svg('<path d="M2.5 4.5h11"/><path d="M6 4.5V3h4v1.5"/><path d="M4.2 4.5l.7 8.5a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8.5"/>', 14),
  info: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.5"/><circle cx="8" cy="5.2" r="0.6" fill="currentColor" stroke="none"/>', 14),
  pin: svg('<path d="M9.5 2.5l4 4-2 1.2-.8 2.8-1.8-1.8L5 12.5l-1.5-1.5 3.8-3.9-1.8-1.8 2.8-.8 1.2-2z"/>', 14),
};

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.cs', '.java', '.cpp', '.c', '.h', '.vue', '.svelte', '.ps1', '.sh']);
const CONFIG_EXTS = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.env', '.xml', '.sln', '.csproj']);
const DOC_EXTS = new Set(['.md', '.mdx', '.txt', '.log', '.pdf', '.doc', '.docx', '.csv']);
const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.mp4', '.mkv', '.mov', '.avi', '.mp3', '.wav', '.flac']);
const ARCHIVE_EXTS = new Set(['.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz']);

export function getEntryIcon(isDirectory: boolean, isExpanded: boolean, ext: string): string {
  if (isDirectory) {
    if (isExpanded) {
      return '<svg width="15" height="15" viewBox="0 0 16 16" fill="#F59E0B" stroke="#D97706" stroke-width="1"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.7l1.3 1.4h5a1 1 0 0 1 1 1v1.2H4.2a1 1 0 0 0-.95.68L1.5 12V3.5z"/><path d="M3.2 6.8h10.8a.7.7 0 0 1 .67.9l-1.3 4.8a1 1 0 0 1-.96.74H2.1a.6.6 0 0 1-.57-.78l1.67-5.66z" fill="#FBBF24"/></svg>';
    }
    return '<svg width="15" height="15" viewBox="0 0 16 16" fill="#F59E0B" stroke="#D97706" stroke-width="1"><path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.2l1.4 1.5H13A1.5 1.5 0 0 1 14.5 5.5v6.5A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4z"/></svg>';
  }

  let color = '#64748B';
  if (CODE_EXTS.has(ext)) color = '#3B82F6';
  else if (CONFIG_EXTS.has(ext)) color = '#EAB308';
  else if (DOC_EXTS.has(ext)) color = '#10B981';
  else if (MEDIA_EXTS.has(ext)) color = '#EC4899';
  else if (ARCHIVE_EXTS.has(ext)) color = '#8B5CF6';

  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z"/><path d="M9.5 2v3.5H13"/></svg>`;
}
