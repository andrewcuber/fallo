export default function RootLoading() {
  return (
    <div className="space-y-10">
      {/* Hero skeleton */}
      <div className="relative overflow-hidden rounded-2xl bg-space p-8 sm:p-10">
        <div className="space-y-4">
          <div className="h-12 sm:h-14 w-3/4 max-w-lg bg-offwhite/10 rounded animate-pulse" />
          <div className="h-12 sm:h-14 w-1/2 max-w-md bg-offwhite/10 rounded animate-pulse" />
          <div className="h-5 w-full max-w-xl bg-offwhite/10 rounded animate-pulse" />
          <div className="h-5 w-2/3 max-w-lg bg-offwhite/10 rounded animate-pulse" />
          <div className="flex flex-wrap gap-3 pt-4">
            <div className="h-10 w-40 bg-offwhite/10 rounded animate-pulse" />
            <div className="h-10 w-36 bg-offwhite/10 rounded animate-pulse" />
          </div>
        </div>
      </div>

      {/* Feature cards skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border bg-card p-5 space-y-4 animate-pulse"
          >
            <div className="h-10 w-10 rounded-lg bg-muted" />
            <div className="space-y-2">
              <div className="h-5 w-40 bg-muted rounded" />
              <div className="h-4 w-full bg-muted rounded" />
              <div className="h-4 w-3/4 bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
