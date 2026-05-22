'use client';

import { useState, useCallback, useEffect } from 'react';

/**
 * useConversations — 多对话管理 hook。
 *
 * - 对话列表持久化到 localStorage
 * - 支持创建、删除、切换对话
 * - 与 useChat({id}) 配合使用：currentId 直接作为 useChat 的 id 参数
 */

export interface Conversation {
  id: string
  title: string
  createdAt: number
  messageCount: number
}

const STORAGE_KEY = 'conversations'
const PLACEHOLDER_ID = 'default-conversation'

function loadFromStorage(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((c: any) => c && typeof c.id === 'string')
  } catch {
    return []
  }
}

function saveToStorage(list: Conversation[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function createDefaultConversation(): Conversation {
  return {
    id: genId(),
    title: '新对话',
    createdAt: Date.now(),
    messageCount: 0,
  }
}

export function useConversations() {
  // 初始状态 server/client 一致：空列表 + 占位 id（避免 useChat id 变化导致消息丢失）
  const [state, setState] = useState<{
    list: Conversation[]
    currentId: string
    hydrated: boolean
  }>({ list: [], currentId: PLACEHOLDER_ID, hydrated: false })

  // useEffect 中从 localStorage 加载，避免 hydration 不匹配
  useEffect(() => {
    const loaded = loadFromStorage()
    if (loaded.length === 0) {
      const def = createDefaultConversation()
      saveToStorage([def])
      setState({ list: [def], currentId: def.id, hydrated: true })
    } else {
      setState({ list: loaded, currentId: loaded[0].id, hydrated: true })
    }
  }, [])

  // 状态变化时持久化（跳过首次 hydration 前的 set）
  useEffect(() => {
    if (!state.hydrated) return
    saveToStorage(state.list)
  }, [state.list, state.hydrated])

  const createConversation = useCallback(() => {
    const conv = createDefaultConversation()
    const newList = [conv, ...state.list]
    setState(prev => ({ list: newList, currentId: conv.id, hydrated: prev.hydrated }))
    return conv.id
  }, [state.list])

  const deleteConversation = useCallback((id: string) => {
    if (state.list.length <= 1) return
    const newList = state.list.filter(c => c.id !== id)
    const nextId = id === state.currentId ? newList[0].id : state.currentId
    setState(prev => ({ list: newList, currentId: nextId, hydrated: prev.hydrated }))
    // 异步删除服务端记忆，不阻塞 UI
    fetch('/api/chat/delete-memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: id }),
    }).catch(() => {})
  }, [state.list, state.currentId])

  const switchConversation = useCallback((id: string) => {
    if (id !== state.currentId) {
      setState(prev => ({ ...prev, currentId: id }))
    }
  }, [state.currentId])

  const updateConversation = useCallback((
    id: string,
    updates: Partial<Conversation>,
  ) => {
    setState(prev => ({
      ...prev,
      list: prev.list.map(c => c.id === id ? { ...c, ...updates } : c),
    }))
  }, [])

  return {
    conversations: state.list,
    currentId: state.currentId,
    hydrated: state.hydrated,
    createConversation,
    deleteConversation,
    switchConversation,
    updateConversation,
  }
}
