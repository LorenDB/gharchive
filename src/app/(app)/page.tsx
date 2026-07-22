import { getCurrentUser } from '@/lib/auth';
import { runAsUserAsync } from '@/lib/user-context';
import { getDashboardData } from '@/lib/server-data';
import DashboardClient from './DashboardClient';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { list?: string };
}) {
  const user = await getCurrentUser();
  // Layout redirects when SSO is required and there is no session
  if (!user) return null;

  const parsed = searchParams.list ? parseInt(searchParams.list, 10) : NaN;
  const activeListId = Number.isFinite(parsed) ? parsed : null;

  const { repos, lists } = await runAsUserAsync(user.id, async () =>
    getDashboardData(activeListId)
  );

  return (
    <DashboardClient
      initialRepos={repos}
      initialLists={lists}
      activeListId={activeListId}
    />
  );
}
