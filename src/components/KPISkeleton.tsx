export function KPISkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="bento-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bento-card flex flex-col gap-3">
          <div className="skeleton h-3 w-20" />
          <div className="skeleton h-7 w-28" />
          <div className="skeleton h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
