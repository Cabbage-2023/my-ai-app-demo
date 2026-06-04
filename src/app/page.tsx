'use client';

import { useChat } from '@ai-sdk/react';
import { HttpChatTransport } from 'ai';
import { useState, useRef, useEffect, useSyncExternalStore, useCallback, memo, useDeferredValue } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Sidebar from './components/Sidebar';
import ScrollIndicator from './components/ScrollIndicator';
import { useConversations } from './hooks/useConversations';

/** 从 <html> class 中读取暗色模式状态 */
function useDarkMode(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const observer = new MutationObserver(onStoreChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );
}

/* ── Helper to format KB source label ── */
function sourceLabel(meta: any) {
  const name = meta?.gameName || meta?.charName || '';
  switch (meta?.type) {
    case 'comment': return `${name} 相关评论`;
    case 'review': return `${name} 相关长评`;
    case 'char_review': return `${name} 相关评论`;
    case 'character': return `${name} 角色介绍`;
    case 'game_intro': return `${name} 作品简介`;
    default: return name || '';
  }
}

/** 低优先级 Markdown 渲染，不阻塞主线程 */
const DeferredMarkdown = memo(function DeferredMarkdown({ text }: { text: string }) {
  const deferredText = useDeferredValue(text);
  return (
    <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-headings:text-fg prose-a:text-miku prose-a:no-underline hover:prose-a:underline prose-code:bg-prose-bg prose-code:px-1 prose-code:rounded prose-code:text-sm prose-pre:bg-prose-bg prose-pre:border prose-pre:border-border prose-pre:rounded-xl prose-li:my-0 prose-strong:text-fg prose-hr:border-border">
      <Markdown remarkPlugins={[remarkGfm]}>{deferredText}</Markdown>
    </div>
  );
});

/** 消息内容（Parts），仅在 parts 引用变化时重渲染 */
const MessageContent = memo(function MessageContent({
  parts,
  messageId,
  isUser,
  collapsedCards,
  toggleCardCollapse,
}: {
  parts: any;
  messageId: string;
  isUser: boolean;
  collapsedCards: Set<string>;
  toggleCardCollapse: (key: string) => void;
}) {
  return parts?.map((part: any, i: number) => {
    const cardKey = `${messageId}-${i}`;

    switch (part.type) {
      /* ── Text ── */
      case 'text':
        if (isUser) {
          return <div key={cardKey} className="whitespace-pre-wrap">{part.text}</div>;
        }
        return (
          <DeferredMarkdown key={cardKey} text={part.text} />
        );

      /* ── Weather tool ── */
      case 'tool-weather': {
        const isIntermediate = parts.some(
          (p: any, index: number) => index > i && p.type === 'tool-convertFahrenheitToCelsius',
        );
        if (part.state === 'output-available') {
          if (isIntermediate) {
            return (
              <div key={cardKey} className="text-xs text-fg-muted italic mt-2">
                已获取原始气象数据...
              </div>
            );
          }
          return (
            <div key={cardKey} className="p-2.5 my-2 bg-miku/5 rounded-xl border border-miku/20">
              <div className="text-sm text-miku-dark font-medium">📍 {part.output.location}</div>
              <div className="text-lg font-semibold text-fg">{part.output.temperature}°F</div>
            </div>
          );
        }
        return (
          <div key={cardKey} className="animate-pulse text-xs text-fg-muted mt-2">
            正在调取气象站...
          </div>
        );
      }

      /* ── Temperature conversion ── */
      case 'tool-convertFahrenheitToCelsius': {
        if (part.state === 'output-available') {
          return (
            <div key={cardKey} className="p-2.5 my-2 bg-gradient-to-r from-miku/10 to-miku-light/20 rounded-xl border border-miku/30">
              <div className="text-xs text-fg-muted">温度换算</div>
              <div className="text-lg font-bold text-miku-dark">{part.output.celsius}°C</div>
            </div>
          );
        }
        return null;
      }

      /* ── Add resource ── */
      case 'tool-addResource': {
        if (part.state === 'output-available') {
          return (
            <div key={cardKey} className="p-2 my-1.5 text-xs text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 rounded-lg border border-emerald-200 dark:border-emerald-800">
              ✅ 已记住一条新信息
            </div>
          );
        }
        return (
          <div key={cardKey} className="animate-pulse text-xs text-fg-muted mt-1">
            正在存入知识库...
          </div>
        );
      }

      /* ── Knowledge base retrieval (collapsible) ── */
      case 'tool-getInformation': {
        if (part.state === 'output-available') {
          const firstWithResults = parts.findIndex(
            (p: any) =>
              p.type === 'tool-getInformation' &&
              p.state === 'output-available' &&
              p.output?.length,
          );
          if (i !== firstWithResults) return null;

          const allResults = parts
            .filter(
              (p: any) =>
                p.type === 'tool-getInformation' && p.state === 'output-available',
            )
            .flatMap((p: any) => p.output || [])
            .filter(Boolean);

          const seen = new Set<string>();
          const unique = allResults.filter((r: any) => {
            const contentKey = typeof r.content === 'string'
              ? r.content.slice(0, 100)
              : String(r.content ?? '');
            const key = `${r.metadata?.source || ''}|${contentKey}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          if (unique.length === 0) return null;

          const collapsed = collapsedCards.has(cardKey);

          return (
            <div
              key={cardKey}
              className={`p-3 my-2 bg-miku/5 rounded-xl border border-miku/25 transition-all duration-200 ${
                collapsed ? 'opacity-60' : ''
              }`}
            >
              <button
                onClick={() => toggleCardCollapse(cardKey)}
                className="flex items-center gap-1.5 w-full text-left font-semibold mb-1 text-miku-dark text-sm group"
              >
                <span className="text-xs transition-transform duration-200">
                  {collapsed ? '▶' : '▼'}
                </span>
                <span>📖 知识库 ({unique.length} 条)</span>
              </button>

              {!collapsed && (
                <>
                  {unique.map((r: any, j: number) => (
                    <div key={j} className={`${j > 0 ? 'mt-2 pt-2 border-t border-miku/10' : ''}`}>
                      <div className="text-sm text-fg leading-relaxed break-words">{r.content}</div>
                      {(r.metadata?.gameName || r.metadata?.charName) && (
                        <div className="text-xs text-fg-muted mt-1">{sourceLabel(r.metadata)}</div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          );
        }
        return (
          <div key={cardKey} className="animate-pulse text-xs text-fg-muted mt-1">
            🔍 正在检索知识库...
          </div>
        );
      }

      /* ── Bangumi Web Search (collapsible, single card with live append) ── */
      case 'tool-searchWeb': {
        // 只渲染第一个 searchWeb part，整轮搜索共用一张卡片
        const firstSearchIdx = parts.findIndex(
          (p: any) => p.type === 'tool-searchWeb',
        );
        if (i !== firstSearchIdx) return null;

        // 是否有搜索仍在进行中
        const anyPending = parts.some(
          (p: any) => p.type === 'tool-searchWeb' && p.state === 'call',
        );

        // 收集所有已返回的结果
        const allResults: any[] = [];
        for (const p of parts) {
          if (p.type === 'tool-searchWeb' && p.state === 'output-available') {
            const data = Array.isArray(p.output) ? p.output : (p.output as any)?.data;
            if (data?.length) allResults.push(...data);
          }
        }

        // 去重
        const seen = new Set<string>();
        const unique = allResults.filter((r: any) => {
          const key = r.name || r.id || '';
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const collapsed = collapsedCards.has(cardKey);

        return (
          <div
            key={cardKey}
            className={`p-3 my-2 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl border border-emerald-200 dark:border-emerald-800 transition-all duration-200 ${
              collapsed ? 'opacity-60' : ''
            }`}
          >
            <button
              onClick={() => toggleCardCollapse(cardKey)}
              className="flex items-center gap-1.5 w-full text-left font-semibold text-emerald-700 dark:text-emerald-400 text-sm group"
            >
              <span className="text-xs transition-transform duration-200">
                {collapsed ? '▶' : '▼'}
              </span>
              <span>🔍 Bangumi 搜索{anyPending ? '' : ` (${unique.length} 条)`}</span>
            </button>

            {!collapsed && (
              <>
                {anyPending && (
                  <div className="animate-pulse text-xs text-emerald-600 dark:text-emerald-400 mb-2">
                    正在搜索 Bangumi...
                  </div>
                )}
                {unique.map((r: any, j: number) => (
                  <div key={j} className={`${j > 0 ? 'mt-2 pt-2 border-t border-emerald-200 dark:border-emerald-800' : ''}`}>
                    <div className="flex items-start gap-2">
                      <span className={`flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        r.type === 'character'
                          ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
                          : 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                      }`}>
                        {r.type === 'character' ? '角色' : '作品'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <a href={r.url} target="_blank" rel="noopener noreferrer"
                          className="text-sm font-medium text-miku hover:underline">
                          {r.name}
                        </a>
                        {r.summary && (
                          <div className="text-xs text-fg-muted mt-0.5 line-clamp-2">{r.summary}</div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {!anyPending && unique.length === 0 && (
                  <div className="text-xs text-fg-muted">未找到相关结果</div>
                )}
              </>
            )}
          </div>
        );
      }

      /* ── Conversation Memory Search (collapsible) ── */
      case 'tool-searchMemory': {
        if (part.state === 'output-available') {
          const collapsed = collapsedCards.has(cardKey);
          const text = typeof part.output === 'string' ? part.output : '';
          if (!text || text === '未找到相关历史对话记录' || text === '暂无历史对话记忆可搜索') return null;

          const lines = text.split('\n').filter(Boolean);
          return (
            <div
              key={cardKey}
              className={`p-3 my-2 bg-violet-50 dark:bg-violet-950/30 rounded-xl border border-violet-200 dark:border-violet-800 transition-all duration-200 ${
                collapsed ? 'opacity-60' : ''
              }`}
            >
              <button
                onClick={() => toggleCardCollapse(cardKey)}
                className="flex items-center gap-1.5 w-full text-left font-semibold mb-1 text-violet-700 dark:text-violet-400 text-sm group"
              >
                <span className="text-xs transition-transform duration-200">
                  {collapsed ? '▶' : '▼'}
                </span>
                <span>💬 历史对话 ({lines.length} 条)</span>
              </button>
              {!collapsed && (
                <div className="space-y-1">
                  {lines.map((line: string, j: number) => (
                    <div key={j} className="text-sm text-fg leading-relaxed whitespace-pre-wrap">{line}</div>
                  ))}
                </div>
              )}
            </div>
          );
        }
        return (
          <div key={cardKey} className="animate-pulse text-xs text-fg-muted mt-1">
            💬 正在搜索历史对话...
          </div>
        );
      }

      default:
        return null;
    }
  });
});

export default function Chat() {
  const {
    conversations,
    currentId,
    hydrated,
    createConversation,
    deleteConversation,
    switchConversation,
    updateConversation,
  } = useConversations();

  const [input, setInput] = useState('');
  const isDark = useDarkMode();

  /* ── Sidebar ── */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  /* ── KB Card collapse ── */
  const [collapsedCards, setCollapsedCards] = useState<Set<string>>(new Set());

  /* ── useChat with multi-conversation support ── */
  const { messages, sendMessage, status, stop, setMessages } = useChat({
    id: currentId,
    transport: new HttpChatTransport({ api: '/ai/api/chat' }),
  });

  /* ── 手动持久化消息到 localStorage ── */
  const prevIdRef = useRef(currentId)
  const initialLoadDone = useRef(false)
  const switchingRef = useRef(false)

  // 切换对话：加载目标对话的消息（不在此保存当前消息，save effect 已实时持久化）
  useEffect(() => {
    if (!prevIdRef.current || !hydrated) {
      prevIdRef.current = currentId
      return
    }
    if (prevIdRef.current !== currentId) {
      switchingRef.current = true
      const saved = localStorage.getItem(`chat:msgs:${currentId}`)
      if (saved) {
        try { setMessages(JSON.parse(saved)) } catch {}
      } else {
        setMessages([])
      }
      prevIdRef.current = currentId
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId])

  // 初始化：hydrated 后从 localStorage 加载
  useEffect(() => {
    if (!hydrated) return
    const saved = localStorage.getItem(`chat:msgs:${currentId}`)
    if (saved) {
      try { setMessages(JSON.parse(saved)) } catch {}
    }
    // 标记首次加载完成，让保存 effect 开始工作
    initialLoadDone.current = true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated])

  // 保存：每次消息变化时写入 localStorage
  // 跳过对话切换时的空消息过渡，避免覆盖已保存的目标对话数据
  useEffect(() => {
    if (!initialLoadDone.current) return
    if (switchingRef.current) {
      switchingRef.current = false
      return
    }
    localStorage.setItem(`chat:msgs:${currentId}`, JSON.stringify(messages))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])
  const isLoading = status === 'submitted' || status === 'streaming';

  const handleCreateConversation = useCallback(() => {
    createConversation();
  }, [createConversation]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevMsgLen = useRef(0);

  /* ── Auto-scroll ── */
  useEffect(() => {
    if (messages.length > prevMsgLen.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgLen.current = messages.length;
  }, [messages]);

  /* ── Auto-title on first user message ── */
  useEffect(() => {
    const userMsgs = messages.filter(m => m.role === 'user');
    if (userMsgs.length === 1) {
      const text = (userMsgs[0].parts as any)?.find((p: any) => p.type === 'text')?.text || '';
      const title = text.slice(0, 20) || '新对话';
      const conv = conversations.find(c => c.id === currentId);
      if (conv && conv.title === '新对话') {
        updateConversation(currentId, { title });
      }
    }
    const userCount = userMsgs.length;
    const conv = conversations.find(c => c.id === currentId);
    if (conv && conv.messageCount !== userCount) {
      updateConversation(currentId, { messageCount: userCount });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.filter(m => m.role === 'user').length]);

  /* ── Dark mode init ── */
  useEffect(() => {
    const stored = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (stored === 'dark' || (!stored && prefersDark)) {
      document.documentElement.classList.add('dark');
    }
  }, []);

  const toggleTheme = () => {
    const html = document.documentElement;
    html.classList.toggle('dark');
    localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
  };

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    sendMessage(
      { text: input },
      { body: { conversationId: currentId } },
    );
    setInput('');
  };

  const toggleCardCollapse = useCallback((key: string) => {
    setCollapsedCards(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /* ── ScrollIndicator rounds（定位到用户发言） ── */
  const rounds = (() => {
    const result: { id: string; label: string }[] = [];
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i].role === 'user' && messages[i + 1].role === 'assistant') {
        const label = (messages[i].parts as any)?.find((p: any) => p.type === 'text')?.text.slice(0, 8) || '查看';
        result.push({ id: messages[i].id, label });
      }
    }
    return result;
  })();

  return (
    <div className={`flex flex-col h-dvh bg-subtle transition-colors ${!sidebarCollapsed ? 'sm:pl-[260px]' : ''}`}>
      {/* ── Sidebar ── */}
      <Sidebar
        conversations={conversations}
        currentId={currentId}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(v => !v)}
        onCreate={handleCreateConversation}
        onDelete={deleteConversation}
        onSwitch={switchConversation}
      />

      {/* ── Header ── */}
      <header className="bg-surface/80 backdrop-blur-sm border-b border-miku/15 px-4 py-3 sticky top-0 z-10 transition-colors">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Hamburger */}
            <button
              onClick={() => setSidebarCollapsed(v => !v)}
              className="w-8 h-8 rounded-full flex items-center justify-center text-fg-muted hover:bg-miku/10 hover:text-miku transition-colors sm:hidden"
              aria-label="切换侧边栏"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            </button>
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-miku to-miku-dark flex items-center justify-center shadow-sm">
              <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <div>
              <h1 className="text-base font-semibold text-fg">Galgame 知识库</h1>
              <p className="text-xs text-fg-muted hidden sm:block">基于真实玩家评价的 AI 助手</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="w-8 h-8 rounded-full flex items-center justify-center text-fg-muted hover:bg-miku/10 hover:text-miku transition-colors"
              aria-label="切换主题"
            >
              {isDark ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="5"/>
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* ── Messages ── */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center mt-32 max-sm:mt-20 text-fg-muted select-none">
              <div className="w-16 h-16 rounded-full bg-miku/10 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-miku" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <p className="text-lg font-medium text-fg-secondary">问我关于 Galgame 的问题</p>
              <p className="text-sm mt-1.5">比如 &quot;Key社有哪些催泪作品&quot; 或 &quot;空门苍线怎么样&quot;</p>
            </div>
          )}

          {messages.map(message => (
            <div key={message.id} className={`flex items-start gap-2.5 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>

              {/* Avatar */}
              <div
                className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shadow-sm mt-1 transition-colors ${
                  message.role === 'user'
                    ? 'bg-border text-fg-muted'
                    : 'bg-gradient-to-br from-miku to-miku-dark text-white'
                }`}
              >
                {message.role === 'user' ? 'U' : 'M'}
              </div>

              {/* Bubble */}
              <div
                className={`max-w-[80%] max-sm:max-w-[calc(100%-3rem)] break-words ${
                  message.role === 'user' ? '' : 'flex-1'
                }`}
                data-round-id={message.role === 'user' ? message.id : undefined}
              >
                <div
                  className={`transition-colors ${
                    message.role === 'user'
                      ? 'bg-miku text-white rounded-2xl rounded-tr-sm px-4 py-2.5'
                      : 'bg-surface text-fg rounded-2xl rounded-tl-sm px-4 py-2.5 border border-border/70 shadow-sm'
                  }`}
                >
                  <MessageContent
                    parts={message.parts}
                    messageId={message.id}
                    isUser={message.role === 'user'}
                    collapsedCards={collapsedCards}
                    toggleCardCollapse={toggleCardCollapse}
                  />

                </div>
              </div>
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── ScrollIndicator ── */}
      <ScrollIndicator containerRef={containerRef as React.RefObject<HTMLDivElement | null>} rounds={rounds} />

      {/* ── Input area ── */}
      <div className="border-t border-border/70 bg-surface px-4 py-3 transition-colors" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-2 bg-subtle rounded-2xl border border-border/80 focus-within:border-miku focus-within:ring-2 focus-within:ring-miku/15 transition-all px-4">
            <input
              className="flex-1 bg-transparent outline-none text-sm text-fg placeholder-fg-muted py-3"
              value={input}
              placeholder="输入问题..."
              onChange={e => setInput(e.currentTarget.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <button
              onClick={isLoading ? stop : handleSend}
              disabled={(!input.trim() && !isLoading)}
              className="flex-shrink-0 w-9 h-9 max-sm:w-11 max-sm:h-11 rounded-full bg-miku hover:bg-miku-dark disabled:bg-fg-muted flex items-center justify-center transition-colors disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="5" height="12" rx="1"/>
                  <rect x="13" y="6" width="5" height="12" rx="1"/>
                </svg>
              ) : (
                <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              )}
            </button>
          </div>
          <p className="text-[11px] text-fg-muted text-center mt-2">AI 回复仅供参考，请以实际游戏体验为准</p>
        </div>
      </div>
    </div>
  );
}
