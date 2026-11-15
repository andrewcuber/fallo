export default function ClimateLoading() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <div className="h-8 w-64 bg-muted rounded animate-pulse" />
        <div className="h-4 w-96 bg-muted rounded animate-pulse" />
        <div className="h-3 w-56 bg-muted rounded animate-pulse" />
      </div>

      {/* Metric cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border bg-card p-5 space-y-3 animate-pulse"
          >
            <div className="h-9 w-9 rounded-lg bg-muted" />
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-8 w-20 bg-muted rounded" />
            <div className="h-3 w-48 bg-muted rounded" />
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5 space-y-3 animate-pulse">
          <div className="h-5 w-40 bg-muted rounded" />
          <div className="h-[280px] bg-muted rounded" />
        </div>
        <div className="rounded-xl border border-border bg-card p-5 space-y-3 animate-pulse">
          <div className="h-5 w-48 bg-muted rounded" />
          <div className="h-[280px] bg-muted rounded" />
        </div>
      </div>

      {/* Annual trend */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3 animate-pulse">
        <div className="h-5 w-48 bg-muted rounded" />
        <div className="h-[300px] bg-muted rounded" />
      </div>
    </div>
  );
}
