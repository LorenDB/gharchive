export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes === 0) return bytes === 0 ? '0 B' : '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatDiskSize(mb: number): string {
  if (mb >= 1024 * 1024) {
    return (mb / (1024 * 1024)).toFixed(1) + ' TB';
  }
  if (mb >= 1024) {
    return (mb / 1024).toFixed(1) + ' GB';
  }
  return mb.toFixed(1) + ' MB';
}

export function formatRelativeTime(iso: string): string {
  // DB timestamps may lack Z; treat naive ISO as UTC
  const normalized = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(normalized);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const normalized = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  return new Date(normalized).toLocaleString();
}

export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const normalized = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  return new Date(normalized).toLocaleDateString();
}
