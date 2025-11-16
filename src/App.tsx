import { useEffect, useRef, useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'

type Role = 'user' | 'assistant' | 'system'
type ChatMessage = {
  id: string
  role: Role
  content: string
  ts?: number
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try { return localStorage.getItem('chat_session_id') } catch { return null }
  })
  const [attachedFile, setAttachedFile] = useState<File | null>(null)
  const [attachedPreviewUrl, setAttachedPreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    try {
      if (sessionId) localStorage.setItem('chat_session_id', sessionId)
      else localStorage.removeItem('chat_session_id')
    } catch {}
  }, [sessionId])
  useEffect(() => {
    // create/revoke local preview URL for attached file (optional)
    if (!attachedFile) {
      setAttachedPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(attachedFile)
    setAttachedPreviewUrl(url)
    return () => { URL.revokeObjectURL(url); setAttachedPreviewUrl(null) }
  }, [attachedFile])
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // optional: initial system message
    setMessages([
      { id: 'sys-1', role: 'system', content: 'How can I help you today! Here to analyse your resume and provide you insights.', ts: Date.now() },
    ])
  }, [])

  useEffect(() => {
    // scroll to bottom when messages change
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  async function sendMessage() {
    const text = input.trim()
    if (!text && !attachedFile) return
    // include attachment name in the user-visible message
    const userContent = text + (attachedFile ? `\n[Attachment: ${attachedFile.name}]` : '')
    const userMsg: ChatMessage = { id: String(Date.now()), role: 'user', content: userContent, ts: Date.now() }
    setMessages((m) => [...m, userMsg])
    setInput('')
    // clear selected file immediately in UI (we will still upload it)
    const fileToUpload = attachedFile
    setAttachedFile(null)
    setSending(true)

    // create assistant placeholder so we can stream into it
    const assistantId = `srv-${Date.now()}`
    const assistantPlaceholder: ChatMessage = { id: assistantId, role: 'assistant', content: '', ts: Date.now() }
    setMessages((m) => [...m, assistantPlaceholder])

    try {
      const base = import.meta.env.VITE_API_BASE ?? ''
      // Always send FormData so backend receives form fields even if no file
      const form = new FormData()
      form.append('userchat', userContent)
      if (sessionId) form.append('session_id', sessionId)
      if (fileToUpload) form.append('file', fileToUpload, fileToUpload.name)

      const fetchOptions: RequestInit = {
        method: 'POST',
        // DO NOT set Content-Type — browser will set multipart boundary
        body: form,
        headers: {
          Accept: 'text/event-stream, text/plain, application/json',
        },
      }

      const res = await fetch(`${base}/chatagent`, fetchOptions)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)

      // if response has body stream, read incrementally
      if (res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let done = false

        const appendToAssistant = (chunkText: string) => {
          if (!chunkText) return
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunkText } : m))
          )
        }

        while (!done) {
          const { value, done: rdone } = await reader.read()
          done = !!rdone
          if (value) {
            const raw = decoder.decode(value, { stream: true })
            // Handle common SSE "data: " prefixes and [DONE] markers
            const cleaned = raw
              .replace(/^data:\s*/gm, '') // remove SSE prefix
              .replace(/\[DONE\]/g, '') // strip done markers

            // split into lines/chunks and attempt to parse JSON pieces;
            // if JSON contains "response" field use that, otherwise append raw text
            const parts = cleaned.split(/\r?\n/).map(p => p.trim()).filter(Boolean)
            for (const part of parts) {
              try {
                const obj = JSON.parse(part)
                if (obj && typeof obj === 'object') {
                  // capture session id if backend emits it in-stream (support snake_case and camelCase)
                  const sid = (obj.session_id ?? obj.sessionId) as string | undefined
                  if (sid && typeof sid === 'string') setSessionId(sid)
                   // show only the "response" field if present
                   if (typeof obj.response === 'string') {
                     appendToAssistant(obj.response)
                   } else {
                     // fallback: any textual fields
                     const txt = String(obj.content ?? obj.message ?? obj.reply ?? '')
                     if (txt) appendToAssistant(txt)
                   }
                 } else {
                   appendToAssistant(String(obj))
                 }
               } catch {
                 // not JSON -> append as plain text
                 appendToAssistant(part)
               }
             }
          }
        }
      } else {
        // fallback: non-streaming JSON/text response
        const contentType = res.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          const data = await res.json()
          // capture session id from final JSON response (support snake_case and camelCase)
          const sid = data?.session_id ?? data?.sessionId
          if (sid && typeof sid === 'string') setSessionId(sid)
           // prefer the "response" field from your backend
           const assistantText =
             (data && typeof data === 'object' && typeof data.response === 'string')
               ? data.response
               : (typeof data === 'string' ? data : (data.reply ?? data.message ?? ''))

          if (assistantText) {
            setMessages((m) => m.map((mm) => (mm.id === assistantId ? { ...mm, content: assistantText } : mm)))
          }
        } else {
          const txt = await res.text()
          setMessages((m) => m.map((mm) => (mm.id === assistantId ? { ...mm, content: txt } : mm)))
        }
      }
    } catch (err: any) {
      const errMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `Error: ${err?.message ?? String(err)}`,
        ts: Date.now(),
      }
      // replace assistant placeholder with error message
      setMessages((m) => m.map((mm) => (mm.id === assistantId ? errMsg : mm)))
    } finally {
      setSending(false)
    }
  }

  // allow textarea or input event
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const formatTime = (ts?: number) => {
    if (!ts) return ''
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <>
      <div className="topbar">
        <div className="logos">
          <a href="https://vite.dev" target="_blank" rel="noreferrer">
            <img src={viteLogo} className="logo" alt="Vite logo" />
          </a>
          <a href="https://react.dev" target="_blank" rel="noreferrer">
            <img src={reactLogo} className="logo react" alt="React logo" />
          </a>
        </div>
        <h1>Professional Agent</h1>
        {sessionId && <div className="session-badge">Session: {sessionId}</div>}
      </div>

      <div className="chat-container">
        <div className="messages" ref={listRef}>
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1
            const showTyping = m.role === 'assistant' && m.content.length === 0 && sending && isLast
            return (
              <div key={m.id} className={`message-row ${m.role === 'user' ? 'right' : m.role === 'assistant' ? 'left' : 'center'}`}>
                {m.role !== 'user' && (
                  <div className="avatar" aria-hidden>
                    {m.role === 'assistant' ? 'Agent' : 'Agent'}
                  </div>
                )}
                <div className={`bubble ${m.role}`}>
                  <div className="message-content">
                    {m.content || (showTyping ? <span className="typing"><span/><span/><span/></span> : null)}
                  </div>
                  <div className="meta">
                    <span className="time">{formatTime(m.ts)}</span>
                    {m.role === 'user' && <span className="you">You</span>}
                  </div>
                </div>
                {m.role === 'user' && (
                  <div className="avatar user" aria-hidden>
                    You
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="composer">
          <div className="attach-row">
            <label className="file-label">
              Attach
              <input
                type="file"
                accept=".pdf,.doc,.docx"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  setAttachedFile(f)
                }}
              />
            </label>
            {attachedFile && (
              <div className="attached-info">
                <span className="filename">{attachedFile.name}</span>
                <button type="button" className="remove-attach" onClick={() => setAttachedFile(null)}>Remove</button>
              </div>
            )}
          </div>
          <textarea
           value={input}
           onChange={(e) => setInput(e.target.value)}
           onKeyDown={handleKeyDown}
           placeholder="Type a message and press Enter (Shift+Enter for newline)..."
           disabled={sending}
           rows={1}
         />
         <button onClick={sendMessage} disabled={sending || !input.trim()} className="send-btn">
           {sending ? 'Sending…' : 'Send'}
         </button>
       </div>
      </div>
    </>
  )
}

export default App