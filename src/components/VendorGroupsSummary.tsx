/**
 * Component to display vendor groups summary with auto-assignment option
 */

import { useState } from 'react';
import { RefreshCw, Check, AlertCircle } from 'lucide-react';
import { useDataStore } from '../store/dataStore';
import { useOrderGroupStore } from '../store/orderGroupStore';
import { initializeOrderGroups } from '../services/orderGroupInitService';
import clsx from 'clsx';

export function VendorGroupsSummary() {
  const data = useDataStore((s) => s.data);
  const { getAllGroups } = useOrderGroupStore();
  const [isInitializing, setIsInitializing] = useState(false);
  const [initStatus, setInitStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const allGroups = getAllGroups();
  const groupsWithItems = allGroups.filter((g) => (g.itemIds?.length ?? 0) > 0);

  const handleAutoAssign = async () => {
    if (!data || !data.items || data.items.size === 0) {
      setInitStatus('error');
      return;
    }

    setIsInitializing(true);
    setInitStatus('idle');

    try {
      const itemsArray = Array.from(data.items.values());
      initializeOrderGroups(itemsArray);
      setInitStatus('success');
      setTimeout(() => setInitStatus('idle'), 3000);
    } catch (error) {
      console.error('Failed to auto-assign items:', error);
      setInitStatus('error');
    } finally {
      setIsInitializing(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-neutral-200 p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-sm text-neutral-900">Vendor Groups</h3>
          <p className="text-xs text-neutral-500 mt-1">
            {allGroups.length} groups, {groupsWithItems.length} with items
          </p>
        </div>

        <button
          onClick={handleAutoAssign}
          disabled={isInitializing || !data}
          className={clsx(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150',
            isInitializing
              ? 'bg-neutral-100 text-neutral-600 cursor-not-allowed'
              : initStatus === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : initStatus === 'error'
              ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20'
          )}
        >
          {isInitializing ? (
            <>
              <RefreshCw size={13} className="animate-spin" />
              Assigning...
            </>
          ) : initStatus === 'success' ? (
            <>
              <Check size={13} />
              Done!
            </>
          ) : initStatus === 'error' ? (
            <>
              <AlertCircle size={13} />
              Failed
            </>
          ) : (
            <>
              <RefreshCw size={13} />
              Auto-Assign Items
            </>
          )}
        </button>
      </div>

      {/* Groups Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {groupsWithItems.map((group) => (
          <div
            key={group.id}
            className="p-2 rounded-lg bg-neutral-50 border border-neutral-200 hover:bg-neutral-100 transition-colors"
          >
            <div className="flex items-center gap-2 mb-1">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: group.color }}
              />
              <span className="text-xs font-medium text-neutral-700 truncate">
                {group.name}
              </span>
            </div>
            <div className="text-xs text-neutral-500">
              {group.itemIds?.length ?? 0} items
            </div>
          </div>
        ))}
      </div>

      {allGroups.length === 0 && (
        <div className="text-center py-4 text-xs text-neutral-500">
          No groups created. Click "Auto-Assign Items" to create vendor groups.
        </div>
      )}
    </div>
  );
}
