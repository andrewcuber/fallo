export default function FieldsLoading() {
  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-9 w-48 bg-muted rounded animate-pulse" />
          <div className="h-4 w-56 bg-muted rounded animate-pulse" />
        </div>
        <div className="h-9 w-28 bg-muted rounded animate-pulse" />
      </div>

      {/* Field cards skeleton */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 rounded-full border-2 border-electric border-t-transparent animate-spin" />
          Loading your fields…
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border bg-card animate-pulse"
          >
            <div className="flex items-center justify-between py-4 px-5">
              <div className="flex items-center gap-4">
                <div className="h-9 w-9 rounded-full bg-muted" />
                <div className="space-y-1.5">
                  <div className="h-4 w-32 bg-muted rounded" />
                  <div className="h-3 w-48 bg-muted rounded" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-8 w-16 bg-muted rounded" />
                <div className="h-8 w-20 bg-muted rounded" />
                <div className="h-8 w-8 bg-muted rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
