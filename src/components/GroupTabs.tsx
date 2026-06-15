/**
 * Horizontal scrolling tabs for quick group access
 * Shows all order groups as clickable tabs
 */

import { useRef, useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useOrderGroupStore } from '../store/orderGroupStore';
import clsx from 'clsx';

interface GroupTabsProps {
  activeGroupId?: string | null;
  onGroupSelect?: (groupId: string | null) => void;
  className?: string;
}

export function GroupTabs({ activeGroupId, onGroupSelect, className }: GroupTabsProps) {
  // Subscribe to the underlying groups record directly. getAllGroups() returns a new
  // sorted array each call, which previously caused infinite useEffect re-runs.
  const groupsRecord = useOrderGroupStore((s) => s.groups);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const groups = useMemo(
    () => Object.values(groupsRecord).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [groupsRecord]
  );

  // Check scroll position
  const checkScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setCanScrollLeft(container.scrollLeft > 0);
    setCanScrollRight(
      container.scrollLeft < container.scrollWidth - container.clientWidth - 10
    );
  };

  useEffect(() => {
    checkScroll();
    const container = scrollContainerRef.current;
    container?.addEventListener('scroll', checkScroll);
    window.addEventListener('resize', checkScroll);

    return () => {
      container?.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
    };
  }, [groups]);

  const scroll = (direction: 'left' | 'right') => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollAmount = 200;
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      {/* Left scroll button */}
      <button
        onClick={() => scroll('left')}
        disabled={!canScrollLeft}
        className={clsx(
          'flex-shrink-0 p-1.5 rounded-lg transition-all duration-150',
          canScrollLeft
            ? 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 cursor-pointer'
            : 'bg-neutral-50 text-neutral-300 cursor-not-allowed'
        )}
        title="Scroll left"
        aria-label="Scroll groups left"
      >
        <ChevronLeft size={16} />
      </button>

      {/* Tabs container */}
      <div
        ref={scrollContainerRef}
        className="flex-1 flex gap-2 overflow-x-auto scrollbar-hide scroll-smooth"
        style={{
          scrollBehavior: 'smooth',
        }}
      >
        {/* "All" tab */}
        <button
          onClick={() => onGroupSelect?.(null)}
          className={clsx(
            'flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150',
            activeGroupId === null || activeGroupId === undefined
              ? 'bg-accent text-white shadow-sm'
              : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
          )}
        >
          All Items
        </button>

        {/* Group tabs */}
        {groups.map((group) => {
          const itemCount = group.itemIds?.length ?? 0;
          const isActive = activeGroupId === group.id;

          return (
            <button
              key={group.id}
              onClick={() => onGroupSelect?.(group.id)}
              className={clsx(
                'flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150 flex items-center gap-1.5',
                isActive
                  ? 'text-white shadow-sm'
                  : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
              )}
              style={
                isActive
                  ? {
                      backgroundColor: group.color,
                      color: 'white',
                    }
                  : {}
              }
              title={`${group.name} (${itemCount} items)`}
            >
              {/* Color dot for inactive tabs */}
              {!isActive && (
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: group.color }}
                />
              )}
              <span>{group.name}</span>
              {itemCount > 0 && (
                <span
                  className={clsx(
                    'text-xs font-semibold px-1.5 rounded',
                    isActive
                      ? 'bg-white/30 text-white'
                      : 'bg-neutral-200 text-neutral-600'
                  )}
                >
                  {itemCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Right scroll button */}
      <button
        onClick={() => scroll('right')}
        disabled={!canScrollRight}
        className={clsx(
          'flex-shrink-0 p-1.5 rounded-lg transition-all duration-150',
          canScrollRight
            ? 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 cursor-pointer'
            : 'bg-neutral-50 text-neutral-300 cursor-not-allowed'
        )}
        title="Scroll right"
        aria-label="Scroll groups right"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
