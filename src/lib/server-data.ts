/**
 * Server-side data loaders shared by RSC pages and API routes' shapes.
 * Call inside runAsUserAsync / withApiUser so tenant scoping applies.
 */

import {
  getDb,
  getLists,
  getListCounts,
  getRepoLists,
  getSettings,
  getGithubAccountPublic,
  DEFAULT_SETTINGS,
  type Settings,
} from '@/lib/db';
import { getSchedulerStatus } from '@/lib/scheduler';
import {
  ALERT_CATEGORIES,
  ALERT_CATEGORY_META,
  isAlertsConfigured,
  type AlertCategory,
} from '@/lib/alerts';
import { getDiskInfo } from '@/lib/disk';
import { isAdmin, type SessionUser } from '@/lib/auth';

const INTERVAL_OPTIONS = [1, 6, 12, 24, 48, 168] as const;

export type RepoListSummary = {
  id: number;
  name: string;
  color: string;
  source: string;
};

export type RepoCardData = {
  id: number;
  platform: string;
  owner: string;
  name: string;
  last_synced_at: string | null;
  created_at: string;
  from_star: boolean;
  from_owned: boolean;
  remote_description: string | null;
  local_description: string | null;
  language: string | null;
  topics: string[];
  stargazers_count: number | null;
  is_archived: boolean;
  is_private: boolean;
  is_fork: boolean;
  lists: RepoListSummary[];
};

export type ListFilterData = {
  id: number;
  name: string;
  description: string | null;
  color: string;
  source: string;
  github_list_id: string | null;
  repo_count: number;
};

export function getRepoCards(listId: number | null = null): RepoCardData[] {
  const { repos } = getDb();
  let filtered = repos;
  if (listId != null && !Number.isNaN(listId)) {
    filtered = repos.filter((r) =>
      getRepoLists(r.id).some((l) => l.id === listId)
    );
  }

  return filtered
    .map((rest) => ({
      id: rest.id,
      platform: rest.platform,
      owner: rest.owner,
      name: rest.name,
      last_synced_at: rest.last_synced_at,
      created_at: rest.created_at,
      from_star: Boolean(rest.from_star),
      from_owned: Boolean(rest.from_owned),
      remote_description: rest.remote_description ?? null,
      local_description: rest.local_description ?? null,
      language: rest.language ?? null,
      topics: rest.topics ?? [],
      stargazers_count: rest.stargazers_count ?? null,
      is_archived: Boolean(rest.is_archived),
      is_private: Boolean(rest.is_private),
      is_fork: Boolean(rest.is_fork),
      lists: getRepoLists(rest.id).map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
        source: l.source,
      })),
    }))
    .sort((a, b) => b.id - a.id);
}

export function getListFilters(): ListFilterData[] {
  const lists = getLists();
  const counts = getListCounts();
  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description ?? null,
    color: l.color,
    source: l.source,
    github_list_id: l.github_list_id ?? null,
    repo_count: counts[l.id] || 0,
  }));
}

export function getDashboardData(listId: number | null = null): {
  repos: RepoCardData[];
  lists: ListFilterData[];
} {
  return {
    repos: getRepoCards(listId),
    lists: getListFilters(),
  };
}

export async function getSettingsPageData(user: SessionUser): Promise<{
  settings: Settings;
  defaults: Settings;
  interval_options: number[];
  scheduler: ReturnType<typeof getSchedulerStatus>;
  alerts: {
    configured: boolean;
    categories: { id: string; label: string; description: string }[];
  };
  disk: Awaited<ReturnType<typeof getDiskInfo>> | null;
  is_admin: boolean;
  github_account: ReturnType<typeof getGithubAccountPublic>;
}> {
  const settings = getSettings();
  let disk = null;
  try {
    disk = await getDiskInfo();
  } catch {
    disk = null;
  }

  return {
    settings,
    defaults: DEFAULT_SETTINGS,
    interval_options: [...INTERVAL_OPTIONS],
    scheduler: getSchedulerStatus(),
    alerts: {
      configured: isAlertsConfigured(settings),
      categories: ALERT_CATEGORIES.map((id) => ({
        id,
        ...ALERT_CATEGORY_META[id as AlertCategory],
      })),
    },
    disk,
    is_admin: isAdmin(user),
    github_account: getGithubAccountPublic(),
  };
}
