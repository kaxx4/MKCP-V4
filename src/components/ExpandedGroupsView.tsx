/**
 * Expanded view showing all order groups with their items
 */

import { useState } from 'react';
import { ChevronDown, ChevronUp, Trash2, Edit2 } from 'lucide-react';
import { useOrderGroupStore } from '../store/orderGroupStore';
import { useDataStore } from '../store/dataStore';
import clsx from 'clsx';

interface ExpandedGroupsViewProps {
  activeGroupId?: string | null;
  onGroupSelect?: (groupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onLoadGroup?: (groupId: string) => void;
}

export function ExpandedGroupsView({
  activeGroupId,
  onGroupSelect,
  onDeleteGroup,
  onLoadGroup,
}: ExpandedGroupsViewProps) {
  const { getAllGroups } = useOrderGroupStore();
  const data = useDataStore((s) => s.data);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

  const allGroups = getAllGroups();
  const itemsMap = new Map(Array.from(data?.items.values() ?? []).map((i) => [i.itemId, i]));

  const toggleExpanded = (groupId: string) => {
    setExpandedGroupId(expandedGroupId === groupId ? null : groupId);
  };

  return (
    <div className="space-y-2">
      {allGroups.length === 0 ? (
        <div className="text-center py-8 text-sm text-neutral-500">
          No order groups. Create groups to organize items.
        </div>
      ) : (
        allGroups.map((group) => {
          const itemCount = group.itemIds?.length ?? 0;
          const isExpanded = expandedGroupId === group.id;
          const isActive = activeGroupId === group.id;

          return (
            <div
              key={group.id}
              className={clsx(
                'border rounded-lg overflow-hidden transition-all duration-150',
                isActive
                  ? 'border-accent bg-accent/5 shadow-sm'
                  : 'border-neutral-200 bg-white hover:border-neutral-300'
              )}
            >
              {/* Header */}
              <button
                onClick={() => toggleExpanded(group.id)}
                className="w-full p-3 flex items-center gap-3 hover:bg-neutral-50 transition-colors"
              >
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: group.color }}
                />

                <div className="flex-1 min-w-0 text-left">
                  <div className="font-medium text-sm text-neutral-900">
                    {group.name}
                  </div>
                  {group.description && (
                    <div className="text-xs text-neutral-500 truncate">
                      {group.description}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs font-semibold tabular-nums px-2 py-1 rounded bg-neutral-100 text-neutral-700">
                    {itemCount}
                  </span>
                  {isExpanded ? (
                    <ChevronUp size={16} className="text-neutral-400" />
                  ) : (
                    <ChevronDown size={16} className="text-neutral-400" />
                  )}
                </div>
              </button>

              {/* Expanded Content */}
              {isExpanded && (
                <div className="border-t border-neutral-200 bg-neutral-50">
                  {/* Items List */}
                  {itemCount > 0 ? (
                    <div className="divide-y divide-neutral-200 max-h-96 overflow-y-auto">
                      {(group.itemIds ?? []).map((itemId) => {
                        const item = itemsMap.get(itemId);
                        if (!item) return null;

                        return (
                          <div
                            key={itemId}
                            className="p-3 text-xs hover:bg-neutral-100 transition-colors flex items-center justify-between"
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-neutral-900 truncate">
                                {item.name}
                              </div>
                              <div className="text-neutral-500 text-xs">
                                ID: {item.itemId}
                              </div>
                            </div>
                            <div className="text-neutral-500 ml-2 flex-shrink-0">
                              {item.baseUnit}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="p-4 text-center text-sm text-neutral-500">
                      No items in this group
                    </div>
                  )}

                  {/* Footer Actions */}
                  <div className="border-t border-neutral-200 p-3 flex gap-2 bg-white">
                    <button
                      onClick={() => {
                        onGroupSelect?.(group.id);
                        toggleExpanded(group.id);
                      }}
                      className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                    >
                      View Items
                    </button>

                    {onLoadGroup && (
                      <button
                        onClick={() => onLoadGroup(group.id)}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-neutral-200 text-neutral-700 hover:bg-neutral-300 transition-colors"
                        title="Load this group into current order"
                      >
                        <Edit2 size={12} />
                      </button>
                    )}

                    {onDeleteGroup && (
                      <button
                        onClick={() => {
                          if (confirm(`Delete "${group.name}"?`)) {
                            onDeleteGroup(group.id);
                          }
                        }}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
                        title="Delete this group"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
