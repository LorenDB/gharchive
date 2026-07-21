/**
 * Shown only when OIDC/SSO is not configured and the app uses autologin.
 */
export default function AuthWarningBanner() {
  return (
    <div
      className="relative z-50 border-b border-amber-500/40 bg-amber-500/15 text-amber-100"
      role="alert"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-start gap-3 text-sm">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-amber-300">
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
          </svg>
        </span>
        <div className="min-w-0 flex-1 leading-relaxed">
          <strong className="font-semibold text-amber-200">
            Authentication is disabled (autologin)
          </strong>
          <span className="text-amber-100/90">
            {' '}
            — Anyone who can reach this instance has full admin access. Set{' '}
            <code className="rounded bg-ink-950/40 px-1 py-0.5 text-[12px] text-amber-50">
              OIDC_ISSUER
            </code>
            ,{' '}
            <code className="rounded bg-ink-950/40 px-1 py-0.5 text-[12px] text-amber-50">
              OIDC_CLIENT_ID
            </code>
            , and related env vars (see{' '}
            <code className="rounded bg-ink-950/40 px-1 py-0.5 text-[12px] text-amber-50">
              .env.example
            </code>
            ) to enable SSO.
          </span>
        </div>
      </div>
    </div>
  );
}
