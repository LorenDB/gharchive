'use client';

import { useState, useEffect, useCallback } from 'react';
import RepoCard from '@/components/RepoCard';
import AddRepoForm from '@/components/AddRepoForm';

export default function Dashboard() {
  const [repos, setRepos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRepos = useCallback(async () => {
    try {
      const res = await fetch('/api/repos');
      const data = await res.json();
      setRepos(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Repositories</h1>
          <p className="text-sm text-gray-500 mt-1">
            {repos.length} archived {repos.length === 1 ? 'repo' : 'repos'}
          </p>
        </div>
        <AddRepoForm onAdded={fetchRepos} />
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : repos.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-500 mb-2">No repositories archived yet.</p>
          <p className="text-gray-600 text-sm">
            Add a GitHub or GitLab repository to start archiving.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map((repo) => (
            <RepoCard key={repo.id} repo={repo} />
          ))}
        </div>
      )}
    </div>
  );
}
