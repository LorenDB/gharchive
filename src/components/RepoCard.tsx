import Link from 'next/link';
import { formatRelativeTime } from '@/lib/format';

interface Repo {
  id: number;
  platform: 'github' | 'gitlab';
  owner: string;
  name: string;
  clone_url: string;
  last_synced_at: string | null;
  created_at: string;
}

export default function RepoCard({ repo }: { repo: Repo }) {
  const platformColor =
    repo.platform === 'github' ? 'text-gray-300' : 'text-orange-400';

  return (
    <Link
      href={`/repos/${repo.id}`}
      className="block p-4 rounded-lg border border-gray-800 bg-gray-900/50 hover:border-gray-700 hover:bg-gray-900 transition-colors"
    >
      <div className="flex items-center gap-3 mb-2">
        <span className={`text-sm font-mono font-bold ${platformColor}`}>
          {repo.platform === 'github' ? 'GH' : 'GL'}
        </span>
        <span className="font-mono text-sm text-gray-200 truncate">
          {repo.owner}/{repo.name}
        </span>
      </div>
      <div className="text-xs text-gray-500">
        {repo.last_synced_at
          ? `Last synced ${formatRelativeTime(repo.last_synced_at)}`
          : 'Never synced'}
      </div>
    </Link>
  );
}
