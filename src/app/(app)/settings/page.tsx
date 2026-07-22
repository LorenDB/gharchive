import { getCurrentUser } from '@/lib/auth';
import { runAsUserAsync } from '@/lib/user-context';
import { getSettingsPageData } from '@/lib/server-data';
import SettingsClient from './SettingsClient';

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const data = await runAsUserAsync(user.id, () =>
    getSettingsPageData(user)
  );

  return (
    <SettingsClient
      initial={{
        settings: data.settings,
        interval_options: data.interval_options,
        scheduler: data.scheduler,
        disk: data.disk,
        alerts_configured: data.alerts.configured,
        is_admin: data.is_admin,
        github_account: data.github_account,
        lists: data.lists,
        users: data.users,
      }}
    />
  );
}
