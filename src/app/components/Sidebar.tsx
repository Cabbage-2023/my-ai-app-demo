'use client';

import type { Conversation } from '../hooks/useConversations';

interface SidebarProps {
  conversations: Conversation[]
  currentId: string
  collapsed: boolean
  onToggleCollapse: () => void
  onCreate: () => void
  onDelete: (id: string) => void
  onSwitch: (id: string) => void
}

export default function Sidebar({
  conversations,
  currentId,
  collapsed,
  onToggleCollapse,
  onCreate,
  onDelete,
  onSwitch,
}: SidebarProps) {
  return (
    <>
      {/* Hamburger button (desktop only; mobile uses header hamburger) */}
      <button
        onClick={onToggleCollapse}
        className={[
          'hidden sm:flex fixed top-3 z-30 w-8 h-8 rounded-full items-center justify-center',
          'text-fg-muted hover:bg-miku/10 hover:text-miku transition-colors',
          collapsed ? 'left-3' : 'left-[268px]',
        ].join(' ')}
        aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {collapsed ? (
            <path d="M9 18l6-6-6-6" />
          ) : (
            <path d="M15 18l-6-6 6-6" />
          )}
        </svg>
      </button>

      {/* Overlay (mobile) */}
      {!collapsed && (
        <div className="fixed inset-0 bg-black/20 z-20 sm:hidden" onClick={onToggleCollapse} />
      )}

      {/* Sidebar */}
      <aside className={[
        'fixed left-0 top-0 h-dvh z-20 bg-surface border-r border-border/70',
        'flex flex-col transition-transform duration-200',
        collapsed ? '-translate-x-full' : 'translate-x-0',
        'w-[260px]',
      ].join(' ')}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-14 border-b border-border/50">
          <span className="text-sm font-semibold text-fg">对话历史</span>
          <button
            onClick={onCreate}
            className="w-7 h-7 rounded-full flex items-center justify-center text-fg-muted hover:bg-miku/10 hover:text-miku transition-colors"
            aria-label="新建对话"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto py-2">
          {conversations.map(conv => (
            <div
              key={conv.id}
              onClick={() => onSwitch(conv.id)}
              onContextMenu={e => {
                e.preventDefault()
                if (conversations.length > 1) onDelete(conv.id)
              }}
              className={[
                'group flex items-center gap-2 px-4 py-3 sm:py-2.5 cursor-pointer transition-colors',
                conv.id === currentId
                  ? 'bg-miku/10 text-miku-dark'
                  : 'text-fg hover:bg-miku/5',
              ].join(' ')}
            >
              <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{conv.title}</div>
                <div className="text-[11px] text-fg-muted">
                  {conv.messageCount} 条消息 · {formatDate(conv.createdAt)}
                </div>
              </div>
              {conversations.length > 1 && (
                <button
                  onClick={e => { e.stopPropagation(); onDelete(conv.id) }}
                  className="w-6 h-6 rounded flex items-center justify-center text-fg-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-all sm:opacity-0 sm:group-hover:opacity-100"
                  aria-label="删除对话"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 text-[11px] text-fg-muted border-t border-border/50">
          右键/长按可删除对话
        </div>
      </aside>
    </>
  );
}

function formatDate(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 3600000) return '刚刚'
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
