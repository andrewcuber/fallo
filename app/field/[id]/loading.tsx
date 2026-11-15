export default function FieldLoading() {
  return (
    <div className="space-y-8">
      {/* Header skeleton */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <div className="h-9 w-64 bg-muted rounded animate-pulse" />
          <div className="h-4 w-48 bg-muted rounded animate-pulse" />
        </div>
        <div className="h-5 w-36 bg-muted rounded animate-pulse" />
      </div>

      {/* Tabs skeleton */}
      <div className="flex gap-1 border-b border-border">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="px-4 py-2.5 border-b-2 -mb-px h-10 w-24 bg-muted rounded-t animate-pulse"
          />
        ))}
      </div>

      {/* Content skeleton */}
      <div className="space-y-4 animate-pulse">
        <div className="h-40 bg-muted rounded-lg" />
      </div>
    </div>
  );
}
