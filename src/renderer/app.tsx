import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Route = 'home' | 'chat' | 'source' | 'trees' | 'history' | 'task';
type Theme = 'system' | 'light' | 'dark';
type Toast = { message: string; error?: boolean } | null;
type AnyRecord = Record<string, any>;

type Task = AnyRecord & { taskId: string; taskText?: string; state: string; createdAt?: string; updatedAt?: string };
type Repository = AnyRecord & { path: string; name?: string; branch?: string; dirty?: boolean };
type Tree = AnyRecord & { id: string; name?: string; path?: string; state?: string; mergeState?: string };
type Conversation = AnyRecord & { id: string; title?: string; updateTime?: number | string; isPinned?: boolean; isTemporary?: boolean };
type ChatSource = { url: string; label: string };
type ChatMessage = { id?: string; role: 'user' | 'assistant'; text: string; kind?: 'message' | 'thought' | 'reasoning'; createdAt?: number | string; status?: string; endTurn?: boolean; sources?: ChatSource[] };
type Chat = Conversation & { messages?: ChatMessage[]; status?: string; url?: string };
type TaskActivity = { id: string; taskId: string; type: string; message: string; createdAt: number };

type Bridge = {
  [key: string]: ((...args: any[]) => any) | undefined;
  onTaskEvent?: (listener: (event: AnyRecord) => void) => (() => void) | void;
};

declare global {
  interface Window { patchwork?: Bridge }
}

const bridge: Bridge = typeof window !== 'undefined' ? window.patchwork || {} : {};
const platformClass = /Mac/i.test(navigator.platform) ? 'platform-mac' : /Win/i.test(navigator.platform) ? 'platform-win' : 'platform-linux';
const call = async <T,>(name: string, ...args: any[]): Promise<T> => {
  const fn = bridge[name];
  if (!fn) throw new Error(`${name} is unavailable in this build.`);
  return fn(...args) as Promise<T>;
};

const text = (value: unknown, fallback = '') => String(value ?? fallback);
const firstLine = (value: unknown) => text(value, 'Untitled task').split('\n')[0].trim() || 'Untitled task';
const formatDate = (value: unknown) => {
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};
const statusLabel = (task: AnyRecord) => ({ prepared: 'Prepared', submitted: 'Running', ready: 'Ready to apply', completed: 'Completed', applied: 'Applied', resolved: 'Resolved', conflicted: 'Needs attention', failed: 'Failed', 'rolled-back': 'Rolled back' } as Record<string, string>)[text(task.state)] || text(task.state, 'Prepared');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : text(error, 'Something went wrong.');
const readCachedConversations = (): Conversation[] => { try { const value = JSON.parse(localStorage.getItem('patchwork.chat-conversations') || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } };
const persistConversations = (items: Conversation[]) => localStorage.setItem('patchwork.chat-conversations', JSON.stringify(items.slice(0, 100)));
const readCachedTaskActivity = (): Record<string, TaskActivity[]> => { try { const value = JSON.parse(localStorage.getItem('patchwork.task-activity') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } };
const persistTaskActivity = (items: Record<string, TaskActivity[]>) => localStorage.setItem('patchwork.task-activity', JSON.stringify(items));
const activityLabel = (value: string) => value.split('-').filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
const timestampMilliseconds = (value: unknown, fallback = 0) => { const numeric = Number(value); if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric; const parsed = Date.parse(text(value)); return Number.isFinite(parsed) ? parsed : fallback; };

function CodeBlock({ value, language = '' }: { value: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return <div className="code-block">{language && <div className="code-language">{language}</div>}<Button type="button" variant="ghost" className="code-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button><pre><code className={language ? `language-${language}` : undefined}>{value}</code></pre></div>;
}

const safeLink = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } };
const inlinePattern = /(`[^`\n]+`|!\[[^\]]*\]\([^\s)]+(?:\s+"[^"]*")?\)|\[[^\]]+\]\([^\s)]+(?:\s+"[^"]*")?\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|<https?:\/\/[^>]+>|https?:\/\/[^\s<]+)/g;
function InlineMarkdown({ value }: { value: string }) {
  const nodes: ReactNode[] = []; let cursor = 0; let match: RegExpExecArray | null; inlinePattern.lastIndex = 0;
  while ((match = inlinePattern.exec(value))) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const token = match[0]; const key = `${match.index}-${token.length}`;
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('![')) { const parsed = /^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)$/.exec(token); const href = parsed && safeLink(parsed[2]); nodes.push(href ? <a className="markdown-image-link" key={key} href={href} title={parsed![3]} target="_blank" rel="noreferrer">Image: {parsed![1] || 'Open image'}</a> : token); }
    else if (token.startsWith('[')) { const parsed = /^\[([^\]]+)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)$/.exec(token); const href = parsed && safeLink(parsed[2]); nodes.push(href ? <a key={key} href={href} title={parsed![3]} target="_blank" rel="noreferrer"><InlineMarkdown value={parsed![1]} /></a> : token); }
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={key}><InlineMarkdown value={token.slice(2, -2)} /></strong>);
    else if (token.startsWith('~~')) nodes.push(<del key={key}><InlineMarkdown value={token.slice(2, -2)} /></del>);
    else if (token.startsWith('*') || token.startsWith('_')) nodes.push(<em key={key}><InlineMarkdown value={token.slice(1, -1)} /></em>);
    else { const raw = token.startsWith('<') ? token.slice(1, -1) : token.replace(/[.,;:!?]+$/, ''); const trailing = token.slice(raw.length + (token.startsWith('<') ? 2 : 0)); const href = safeLink(raw); nodes.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer">{raw}</a> : token); if (trailing) nodes.push(trailing); }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return <>{nodes}</>;
}

const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
const isBlockStart = (lines: string[], index: number) => /^\s*```|^#{1,6}\s+|^\s*>\s?|^\s*(?:[-+*]|\d+[.)])\s+|^\s*(?:---+|___+|\*\*\*+)\s*$/.test(lines[index] || '') || Boolean(lines[index + 1] && /\|/.test(lines[index]) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]));
function renderMarkdownBlocks(value: string, keyPrefix = 'md'): ReactNode[] {
  const lines = value.replaceAll('\r\n', '\n').split('\n'); const result: ReactNode[] = []; let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) { index += 1; continue; }
    const key = `${keyPrefix}-${index}`; const fence = /^\s*```([^\s`]*)\s*$/.exec(lines[index]);
    if (fence) { const content: string[] = []; index += 1; while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) content.push(lines[index++]); if (index < lines.length) index += 1; result.push(<CodeBlock key={key} value={content.join('\n')} language={fence[1]} />); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[index]);
    if (heading) { const level = heading[1].length; result.push(<div className={`markdown-heading markdown-h${level}`} role="heading" aria-level={level} key={key}><InlineMarkdown value={heading[2].replace(/\s+#+\s*$/, '')} /></div>); index += 1; continue; }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(lines[index])) { result.push(<hr key={key} />); index += 1; continue; }
    if (/^\s*>/.test(lines[index])) { const quote: string[] = []; while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, '')); result.push(<blockquote key={key}>{renderMarkdownBlocks(quote.join('\n'), key)}</blockquote>); continue; }
    if (index + 1 < lines.length && /\|/.test(lines[index]) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) { const headers = tableCells(lines[index]); const aligns = tableCells(lines[index + 1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left'); const rows: string[][] = []; index += 2; while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) rows.push(tableCells(lines[index++])); result.push(<div className="markdown-table-wrap" key={key}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex} style={{ textAlign: aligns[cellIndex] as any }}><InlineMarkdown value={cell} /></th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex} style={{ textAlign: aligns[cellIndex] as any }}><InlineMarkdown value={row[cellIndex] || ''} /></td>)}</tr>)}</tbody></table></div>); continue; }
    const list = /^\s*((?:[-+*])|(?:\d+[.)]))\s+(.+)$/.exec(lines[index]);
    if (list) { const ordered = /^\d/.test(list[1]); const start = ordered ? Number.parseInt(list[1], 10) : undefined; const items: string[] = []; while (index < lines.length) { const item = /^\s*((?:[-+*])|(?:\d+[.)]))\s+(.+)$/.exec(lines[index]); if (!item || /^\d/.test(item[1]) !== ordered) break; items.push(item[2]); index += 1; } const children = items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown value={item} /></li>); result.push(ordered ? <ol key={key} start={start}>{children}</ol> : <ul key={key}>{children}</ul>); continue; }
    const paragraph: string[] = [lines[index++]]; while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) paragraph.push(lines[index++]); result.push(<p key={key}>{paragraph.map((line, lineIndex) => <span key={lineIndex}><InlineMarkdown value={line} />{lineIndex < paragraph.length - 1 && <br />}</span>)}</p>);
  }
  return result;
}

function Markdown({ value }: { value: string }) {
  return <div className="markdown">{renderMarkdownBlocks(value)}</div>;
}

const isReasoningMessage = (item: ChatMessage) => item.kind === 'thought' || item.kind === 'reasoning';
function Reasoning({ item, working, latest }: { item: ChatMessage; working: boolean; latest: boolean }) {
  const thinking = item.kind === 'thought'; const active = thinking && working && latest;
  return <details className={`reasoning-card ${thinking ? 'thought-card' : 'summary-card'}`} open={active}><summary>{active ? <i className="mini-spinner" aria-hidden="true" /> : <span className="reasoning-spark">✦</span>}<span>{thinking ? (active ? 'Thinking' : 'Thoughts') : 'Reasoning summary'}</span></summary><Markdown value={item.text} /></details>;
}

function Sources({ items }: { items?: ChatSource[] }) {
  if (!items?.length) return null;
  return <div className="message-sources" aria-label="Sources">{items.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}><span>{index + 1}</span>{source.label}</a>)}</div>;
}

function Icon({ children }: { children: ReactNode }) { return <span className="icon" aria-hidden="true">{children}</span>; }
function Button({ children, variant = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>;
}
function Empty({ title, copy, action }: { title: string; copy?: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-mark">✦</div><strong>{title}</strong>{copy && <span>{copy}</span>}{action}</div>;
}
function Modal({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <header className="modal-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div><Button variant="ghost" aria-label="Close" onClick={onClose}>×</Button></header>
      {children}
    </section>
  </div>;
}

function Sidebar({ route, onRoute, onTaskSelect, collapsed, setCollapsed, tasks, conversations, onNewTask, onNewChat, theme, setTheme, authenticated, onOpenSession, onResetAuthentication }: { route: Route; onRoute: (route: Route) => void; onTaskSelect: (task: Task) => void; collapsed: boolean; setCollapsed: (value: boolean) => void; tasks: Task[]; conversations: Conversation[]; onNewTask: () => void; onNewChat: () => void; theme: Theme; setTheme: (value: Theme) => void; authenticated: boolean; onOpenSession: () => void; onResetAuthentication: () => void }) {
  const nav = [{ id: 'home' as Route, icon: '⌂', label: 'Home' }, { id: 'chat' as Route, icon: '✦', label: 'Chats', count: conversations.length }, { id: 'source' as Route, icon: '⑂', label: 'Source control' }, { id: 'trees' as Route, icon: '⑃', label: 'Coding trees' }, { id: 'history' as Route, icon: '◷', label: 'Task history', count: tasks.length }];
  return <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="sidebar-top"><Button variant="ghost" className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Icon>☰</Icon></Button>{!collapsed && <div className="brand"><span className="brand-mark">C</span><div><strong>ChatGPT - Coder</strong><small>Patchwork coding workspace</small></div></div>}</div>
    <div className="sidebar-actions"><Button variant="primary" onClick={onNewTask}><Icon>＋</Icon>{!collapsed && 'New task'}</Button><Button variant="secondary" onClick={onNewChat}><Icon>✦</Icon>{!collapsed && 'New chat'}</Button></div>
    <nav className="main-nav" aria-label="Workspace">{nav.map((item) => <button key={item.id} className={`nav-item ${route === item.id ? 'active' : ''}`} onClick={() => onRoute(item.id)} title={collapsed ? item.label : undefined}><Icon>{item.icon}</Icon>{!collapsed && <><span>{item.label}</span>{item.count ? <small>{item.count}</small> : null}</>}</button>)}</nav>
    {!collapsed && <><div className="sidebar-section-title">Recent tasks</div><div className="sidebar-list">{tasks.slice(0, 6).map((task) => <button className="sidebar-task" key={task.taskId} onClick={() => onTaskSelect(task)}><span>{firstLine(task.taskText)}</span><small>{task.state === 'submitted' && <i className="mini-spinner" aria-hidden="true" />}{statusLabel(task)}</small></button>)}{tasks.length === 0 && <span className="sidebar-muted">No tasks yet.</span>}</div></>}
    <div className="sidebar-spacer" />
    <div className="theme-picker" aria-label="Theme"><Icon>◐</Icon>{!collapsed && <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}><option value="system">System theme</option><option value="light">Light theme</option><option value="dark">Dark theme</option></select>}</div>
    <div className="session-actions"><button type="button" className="session-button" onClick={onOpenSession} title={collapsed ? 'Open ChatGPT' : undefined}><span className={`connection-dot ${authenticated ? '' : 'offline'}`} />{!collapsed && <span>{authenticated ? 'ChatGPT connected' : 'Sign in to ChatGPT'}</span>}</button>{!collapsed && <button type="button" className="session-reset" onClick={onResetAuthentication}>Reset sign-in</button>}</div>
  </aside>;
}

function Header({ title, onToggleSidebar, right }: { title: string; onToggleSidebar: () => void; right?: ReactNode }) {
  return <header className="topbar"><div className="topbar-title"><Button variant="ghost" className="mobile-menu" onClick={onToggleSidebar} aria-label="Toggle sidebar"><Icon>☰</Icon></Button><h1>{title}</h1></div><div className="topbar-actions">{right}</div></header>;
}

function Home({ repositories, trees, projects, iacConfig, promptIds, skillIds, attachments, setAttachments, preferredTreeId, onAddRepository, onCreateTask, onOpenSkills, onOpenPrompts }: { repositories: Repository[]; trees: Tree[]; projects: AnyRecord[]; iacConfig: AnyRecord | null; promptIds: string[]; skillIds: string[]; attachments: AnyRecord[]; setAttachments: (items: AnyRecord[]) => void; preferredTreeId?: string; onAddRepository: () => void; onCreateTask: (input: AnyRecord) => Promise<void>; onOpenSkills: () => void; onOpenPrompts: () => void }) {
  const preferredTree = trees.find((tree) => tree.id === preferredTreeId); const [taskText, setTaskText] = useState(''); const [model, setModel] = useState('default'); const [reasoning, setReasoning] = useState('default'); const [treeId, setTreeId] = useState(preferredTreeId || ''); const [projectId, setProjectId] = useState(''); const [repositoryPath, setRepositoryPath] = useState(preferredTree?.repositoryPath || repositories[0]?.path || ''); const [createTree, setCreateTree] = useState(false); const [treeName, setTreeName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false); const [includeIac, setIncludeIac] = useState(false);
  const iacSelectors = Array.isArray(iacConfig?.selectors) ? iacConfig.selectors.filter((item: unknown) => text(item).trim()) : [];
  const iacAvailable = Boolean(iacConfig?.exists && iacConfig?.valid && iacSelectors.length);
  useEffect(() => { if (repositories[0] && !repositories.some((item) => item.path === repositoryPath)) setRepositoryPath(repositories[0].path); }, [repositories, repositoryPath]);
  useEffect(() => { setModel(localStorage.getItem('patchwork.task-model') || 'default'); setReasoning(localStorage.getItem('patchwork.task-reasoning') || 'default'); setProjectId(localStorage.getItem('patchwork.task-project') || ''); setRepositoryPath(preferredTree?.repositoryPath || localStorage.getItem('patchwork.task-repository') || repositories[0]?.path || ''); if (!preferredTreeId) setTreeId(localStorage.getItem('patchwork.task-tree') || ''); setIncludeIac(localStorage.getItem('patchwork.task-iac') === 'true'); setSettingsLoaded(true); }, []);
  useEffect(() => { if (!settingsLoaded) return; localStorage.setItem('patchwork.task-model', model); localStorage.setItem('patchwork.task-reasoning', reasoning); localStorage.setItem('patchwork.task-project', projectId); localStorage.setItem('patchwork.task-repository', repositoryPath); localStorage.setItem('patchwork.task-tree', treeId); localStorage.setItem('patchwork.task-iac', String(includeIac && iacAvailable)); }, [settingsLoaded, model, reasoning, projectId, repositoryPath, treeId, includeIac, iacAvailable]);
  useEffect(() => { if (iacConfig && !iacAvailable) setIncludeIac(false); }, [iacConfig, iacAvailable]);
  useEffect(() => { const tree = trees.find((item) => item.id === preferredTreeId); if (tree) { setTreeId(tree.id); setRepositoryPath(tree.repositoryPath || repositoryPath); setCreateTree(false); } }, [preferredTreeId, trees, repositoryPath]);
  const chooseAttachments = async () => { try { const chosen = await call<AnyRecord[]>('chooseAttachments'); setAttachments([...attachments, ...(chosen || [])]); } catch (e) { setError(errorMessage(e)); } };
  const submit = async (event: FormEvent) => { event.preventDefault(); const repository = repositories.find((item) => item.path === repositoryPath); if (!taskText.trim() || !repository) { setError(repository ? 'Describe the task before continuing.' : 'Choose one repository before creating a task.'); return; } const taskRepositories = [repository, ...repositories.filter((item) => item.path !== repository.path)]; setBusy(true); setError(''); try { await onCreateTask({ repositories: taskRepositories, taskText: taskText.trim(), model, reasoningMode: reasoning, treeId: treeId || null, createTree, treeName, skillIds, promptIds, attachments, includeIac: includeIac && iacAvailable, autoApply: true, chatgptProject: projects.find((project) => project.id === projectId) || null }); setTaskText(''); setAttachments([]); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  return <div className="page page-home"><div className="hero"><div><div className="eyebrow">WORKSPACE</div><h2>What are you building?</h2><p>Describe a coding task and Patchwork will prepare a validated Git bundle for ChatGPT.</p></div><div className="hero-orb">✦</div></div>
    <form className="composer-card" onSubmit={submit}><textarea value={taskText} onChange={(e) => setTaskText(e.target.value)} placeholder="Describe your coding task…" rows={5} autoFocus /><div className="composer-toolbar"><div className="composer-tools"><Button type="button" variant="ghost" onClick={chooseAttachments}><Icon>⌕</Icon>Attach</Button><Button type="button" variant="ghost" onClick={onOpenSkills}><Icon>✧</Icon>Skills</Button><Button type="button" variant="ghost" onClick={onOpenPrompts}><Icon>▤</Icon>Prompts</Button></div><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Preparing…' : 'Prepare task'} <span>↗</span></Button></div>{attachments.length > 0 && <div className="chips">{attachments.map((attachment) => <span className="chip" key={attachment.path}>{attachment.name}<button type="button" onClick={() => setAttachments(attachments.filter((item) => item.path !== attachment.path))}>×</button></span>)}</div>}{error && <div className="form-error">{error}</div>}</form>
    <div className="home-grid"><section className="panel"><div className="panel-heading"><div><div className="eyebrow">CONTEXT</div><h3>Repositories</h3></div><Button variant="ghost" onClick={onAddRepository}>＋ Add</Button></div>{repositories.length ? repositories.map((repo) => <div className="repo-row" key={repo.path}><span className="repo-icon">⌘</span><div><strong>{repo.name || repo.path.split('/').pop()}</strong><small>{repo.path}</small></div><span className={repo.isClean === false ? 'status-warning' : 'status-success'}>{repo.isClean === false ? 'Changes' : 'Clean'}</span></div>) : <Empty title="No repository selected" copy="Add a Git repository to give ChatGPT context." action={<Button onClick={onAddRepository}>Add repository</Button>} />}</section>
      <section className="panel"><div className="panel-heading"><div><div className="eyebrow">CONFIGURATION</div><h3>Task settings</h3></div></div><label>Primary repository<select value={repositoryPath} onChange={(e) => setRepositoryPath(e.target.value)}>{repositories.map((repo) => <option value={repo.path} key={repo.path}>{repo.name || repo.path}</option>)}</select><small className="field-help">All {repositories.length} workspace repositor{repositories.length === 1 ? 'y is' : 'ies are'} included. The primary repository is the writable source when creating a coding tree.</small></label><div className="field-grid"><label>Model<select value={model} onChange={(e) => setModel(e.target.value)}><option value="default">ChatGPT default</option><option value="sol">GPT-5.6 Sol</option><option value="luna">GPT-5.6 Luna</option></select></label><label>Reasoning<select value={reasoning} onChange={(e) => setReasoning(e.target.value)}><option value="default">Model default</option><option value="instant">Instant</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="extra-high">Extra High</option></select></label></div><label>Target<select value={createTree ? '__new__' : treeId} onChange={(e) => { setCreateTree(e.target.value === '__new__'); setTreeId(e.target.value === '__new__' ? '' : e.target.value); }}><option value="">Current repositories</option>{trees.map((tree) => <option key={tree.id} value={tree.id}>{tree.name || tree.id}</option>)}<option value="__new__">Create a new coding tree…</option></select></label>{createTree && <label>New tree name<input value={treeName} onChange={(e) => setTreeName(e.target.value)} placeholder="Feature name" /></label>}<label>ChatGPT project<select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">New chat</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label className="toggle-option"><input type="checkbox" checked={includeIac && iacAvailable} disabled={!iacAvailable} onChange={(event) => setIncludeIac(event.target.checked)} /><span><strong>Include infrastructure context</strong><small>{!iacConfig ? 'Checking IaC settings…' : !iacConfig.valid ? `IaC settings error: ${iacConfig.error || 'Invalid settings'}` : !iacConfig.exists ? `No settings file found at ${iacConfig.settingsPath}.` : !iacSelectors.length ? `No iac_urls configured in ${iacConfig.settingsPath}.` : `${iacSelectors.length} configured IaC repositor${iacSelectors.length === 1 ? 'y' : 'ies'} will be included read-only.`}</small></span></label><div className="selection-summary">{promptIds.length ? `${promptIds.length} saved prompt${promptIds.length === 1 ? '' : 's'} selected · ` : ''}{skillIds.length ? `${skillIds.length} skill${skillIds.length === 1 ? '' : 's'} selected` : 'No skills selected'}</div></section></div>
  </div>;
}

function ChatWorkspace({ conversations, activeChat, awaitingReply, historyError, threadError, onSelect, onRefresh, onSend, onStop, onNew, model, setModel }: { conversations: Conversation[]; activeChat: Chat | null; awaitingReply: boolean; historyError: string; threadError: string; onSelect: (id: string) => void; onRefresh: () => void; onSend: (message: string, attachments: AnyRecord[], reasoningMode: string) => Promise<void>; onStop: () => Promise<void>; onNew: () => void; model: string; setModel: (model: string) => void }) {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<AnyRecord[]>([]);
  const [reasoning, setReasoning] = useState(localStorage.getItem('patchwork.chat-reasoning') || 'default');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const working = awaitingReply || activeChat?.status === 'streaming';
  const modelLabel = model === 'luna' ? 'GPT-5.6 Luna' : 'GPT-5.6 Sol';
  const thinkingLabel = ({ default: 'Model default', instant: 'Instant', low: 'Low', medium: 'Medium', high: 'High', 'extra-high': 'Extra High' } as Record<string, string>)[reasoning] || 'Model default';
  const chooseAttachments = async () => { try { const chosen = await call<AnyRecord[]>('chooseAttachments'); setAttachments((items) => [...items, ...(chosen || []).filter((next) => !items.some((item) => item.path === next.path))]); } catch (e) { setError(errorMessage(e)); } };
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!message.trim() || busy || working) return; const outgoing = message.trim(); setBusy(true); setError(''); try { setMessage(''); await onSend(outgoing, attachments, reasoning); setAttachments([]); } catch (e) { setMessage(outgoing); setError(errorMessage(e)); } finally { setBusy(false); } };
  const stop = async () => { setStopping(true); setError(''); try { await onStop(); } catch (e) { setError(errorMessage(e)); } finally { setStopping(false); } };
  return <div className="chat-workspace">
    <aside className="chat-sidebar">
      <div className="chat-sidebar-header"><div><div className="eyebrow">CHATGPT</div><h2>Chats</h2></div><Button variant="ghost" onClick={onRefresh} aria-label="Refresh chats">↻</Button></div>
      <Button variant="secondary" className="chat-new-button" onClick={onNew}>＋ New chat</Button>
      {historyError && <div className="chat-notice"><strong>History temporarily unavailable</strong><span>{historyError} Active conversations still refresh directly.</span></div>}
      <div className="chat-list">{conversations.map((conversation) => <button key={conversation.id} className={`chat-list-item ${conversation.id === activeChat?.id ? 'active' : ''}`} onClick={() => onSelect(conversation.id)}><strong>{conversation.title || 'New chat'}</strong><small>{conversation.id === activeChat?.id && working && <i className="mini-spinner" aria-hidden="true" />}{conversation.isPinned ? 'Pinned · ' : ''}{formatDate(conversation.updateTime)}</small></button>)}{conversations.length === 0 && <Empty title="No conversations" copy="Start a new ChatGPT conversation." />}</div>
    </aside>
    <section className="chat-thread">
      <header className="thread-header"><div><h2>{activeChat?.title || 'New chat'}</h2><span>{working ? 'ChatGPT is working…' : 'Native workspace chat'}</span></div></header>
      <div className="messages">{activeChat?.messages?.length ? activeChat.messages.map((item, index) => <article className={`message message-${item.role} ${isReasoningMessage(item) ? 'message-reasoning' : ''}`} key={item.id || index}>{isReasoningMessage(item) ? <Reasoning item={item} working={working} latest={index === activeChat.messages!.length - 1} /> : <><div className="message-author">{item.role === 'user' ? 'You' : 'ChatGPT'}</div>{item.role === 'assistant' ? <><Markdown value={item.text} /><Sources items={item.sources} /></> : <div className="message-bubble">{item.text}</div>}</>}</article>) : <Empty title="How can I help?" copy="Ask ChatGPT about a task, a codebase, or an idea." />}{threadError && <div className="inline-notice thread-notice">{threadError}</div>}{working && <div className="working-row" role="status"><i className="mini-spinner" aria-hidden="true" /><span>ChatGPT is working</span></div>}</div>
      <form className="chat-composer" onSubmit={submit}>
        {attachments.length > 0 && <div className="chips">{attachments.map((attachment) => <span className="chip" key={attachment.path}>{attachment.name}<button type="button" onClick={() => setAttachments((items) => items.filter((item) => item.path !== attachment.path))}>×</button></span>)}</div>}
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Message ChatGPT" rows={3} disabled={busy || working} />
        <div className="chat-composer-actions">
          <div className="chat-composer-settings">
            <Button type="button" variant="ghost" onClick={chooseAttachments} aria-label="Attach files" disabled={working}>＋ Attach</Button>
            <div className="model-thinking-picker">
              <button type="button" className="model-thinking-trigger" aria-haspopup="menu" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)} disabled={busy || working}>
                <span>{modelLabel}</span><span aria-hidden="true">·</span><span>{thinkingLabel}</span><span className="picker-chevron" aria-hidden="true">⌄</span>
              </button>
              {settingsOpen && <div className="model-thinking-menu" role="menu" aria-label="Model and thinking settings">
                <div className="model-thinking-menu-label">Model</div>
                {[['sol', 'GPT-5.6 Sol'], ['luna', 'GPT-5.6 Luna']].map(([value, label]) => <button type="button" role="menuitemradio" aria-checked={model === value} key={value} onClick={() => { setModel(value); setSettingsOpen(false); }}><span>{label}</span>{model === value && <span aria-hidden="true">✓</span>}</button>)}
                <div className="model-thinking-menu-divider" />
                <div className="model-thinking-menu-label">Thinking</div>
                {[['default', 'Model default'], ['instant', 'Instant'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['extra-high', 'Extra High']].map(([value, label]) => <button type="button" role="menuitemradio" aria-checked={reasoning === value} key={value} onClick={() => { setReasoning(value); localStorage.setItem('patchwork.chat-reasoning', value); setSettingsOpen(false); }}><span>{label}</span>{reasoning === value && <span aria-hidden="true">✓</span>}</button>)}
              </div>}
            </div>
          </div>
          <span className="chat-send-hint">{busy ? 'Sending…' : working ? 'Streaming the active response' : 'Enter to send · Shift+Enter for a new line'}</span>
          {working ? <Button type="button" className="stop-button" onClick={stop} disabled={stopping} aria-label="Stop response"><span className="stop-square" />{stopping ? 'Stopping…' : 'Stop'}</Button> : <Button type="submit" variant="primary" disabled={busy || !message.trim()}>Send</Button>}
        </div>
        {error && <div className="form-error">{error}</div>}
      </form>
    </section>
  </div>;
}

function TaskDetail({ task, trees, conversation, conversationLoading, conversationError, activity, onAction, onConflict, onDelete, onSetTarget, onRefreshConversation }: { task: Task | null; trees: Tree[]; conversation: Chat | null; conversationLoading: boolean; conversationError: string; activity: TaskActivity[]; onAction: (name: string) => Promise<void>; onConflict: () => void; onDelete: () => Promise<void>; onSetTarget: (treeId: string | null) => Promise<void>; onRefreshConversation: () => void }) {
  if (!task) return <div className="page"><Empty title="Select a task" copy="Choose a task from the sidebar or create a new one." /></div>;
  const result = task.result;
  const canChangeTarget = !['applied', 'rolled-back', 'resolved'].includes(task.state);
  const assistantUpdates = (conversation?.messages || []).filter((message) => message.role === 'assistant').slice(-20);
  const feed = [
    ...activity.map((entry) => ({ id: entry.id, kind: 'activity' as const, createdAt: entry.createdAt, activity: entry })),
    ...assistantUpdates.map((message, index) => ({ id: message.id || `assistant-${index}`, kind: 'message' as const, createdAt: timestampMilliseconds(message.createdAt || conversation?.updateTime), message })),
  ].sort((left, right) => left.createdAt - right.createdAt).slice(-40);
  const working = task.state === 'submitted' || task.chatStatus === 'streaming';
  return <div className="page page-task"><div className="task-heading"><div><div className="eyebrow">TASK</div><h2>{firstLine(task.taskText)}</h2><p>{formatDate(task.createdAt)} · {statusLabel(task)}</p></div><div className="task-heading-actions"><Button onClick={() => onAction('openChatInSession')}>Open ChatGPT</Button><span className={`status-badge ${task.state}`}>{working && <i className="mini-spinner" aria-hidden="true" />}{statusLabel(task)}</span></div></div><div className="task-grid"><div className="task-primary"><section className="panel task-main"><div className="panel-heading"><div><div className="eyebrow">REQUEST</div><h3>Task instructions</h3></div><Button variant="danger" onClick={onDelete}>Delete</Button></div><Markdown value={text(task.taskText)} /><div className="task-actions">{task.state === 'prepared' && <Button variant="primary" onClick={() => onAction('submitTask')}>Submit to ChatGPT</Button>}{task.state === 'ready' && !task.summaryOnly && <Button variant="primary" onClick={() => onAction('applyTask')}>Apply changes</Button>}{task.state === 'ready' && task.summaryOnly && <Button variant="primary" onClick={() => onAction('useGitSummary')}>Use in Source Control</Button>}{task.state === 'conflicted' && <><Button variant="primary" onClick={() => onAction('retryApplyTask')}>Retry apply</Button><Button onClick={onConflict}>Resolve with ChatGPT</Button></>}{task.state === 'applied' && <Button variant="danger" onClick={() => onAction('rollbackTask')}>Roll back</Button>}<Button onClick={() => onAction('copyPrompt')}>Copy prompt</Button><Button onClick={() => onAction('revealPackage')}>Show package</Button><Button onClick={() => onAction('importResult')}>Import result</Button></div></section><section className="panel task-updates-panel"><div className="panel-heading"><div><div className="eyebrow">CHATGPT UPDATES</div><h3>Live task transcript</h3></div><Button variant="ghost" disabled={!task.conversationId || conversationLoading} onClick={onRefreshConversation}>{conversationLoading ? 'Refreshing…' : '↻ Refresh'}</Button></div>{conversationError && <div className="inline-notice">{conversationError}</div>}<div className="task-updates">{feed.map((item) => item.kind === 'activity' ? <div className="task-progress-row" key={item.id}><span className={working && item === feed.at(-1) ? 'mini-spinner' : 'activity-dot'} aria-hidden="true" /><div><strong>{item.activity.message}</strong><small>{activityLabel(item.activity.type)} · {formatDate(item.activity.createdAt)}</small></div></div> : isReasoningMessage(item.message) ? <div className="task-reasoning" key={item.id}><Reasoning item={item.message} working={working} latest={item === feed.at(-1)} /></div> : <article className="task-update" key={item.id}><div className="task-update-heading"><span>ChatGPT</span>{item.message.createdAt && <small>{formatDate(timestampMilliseconds(item.message.createdAt))}</small>}</div><Markdown value={item.message.text} /></article>)}{working && <div className="working-row" role="status"><i className="mini-spinner" aria-hidden="true" /><span>ChatGPT is working</span></div>}{feed.length === 0 && !working && <Empty title={task.conversationId ? 'Waiting for an update' : 'Task not submitted yet'} copy={task.conversationId ? 'Visible replies, thinking updates, and reasoning summaries appear here automatically.' : 'Conversation updates appear after ChatGPT accepts the task.'} />}</div></section></div><aside className="task-side"><section className="panel"><div className="eyebrow">APPLY TARGET</div><label>Destination<select value={task.treeId || ''} disabled={!canChangeTarget} onChange={(event) => onSetTarget(event.target.value || null)}><option value="">Original repository</option>{trees.map((tree) => <option value={tree.id} key={tree.id}>{tree.name || tree.id}</option>)}</select></label>{!canChangeTarget && <p className="panel-note">Applied tasks keep their recorded destination.</p>}</section><section className="panel"><div className="eyebrow">RESULT</div>{result ? <><h3>{result.summary || 'Validated result'}</h3><div className="patch-list">{(result.patches || []).map((patch: AnyRecord) => <div className="patch-item" key={patch.id || patch.name}><strong>{patch.name || patch.id}</strong><code>{patch.stat || 'Changes ready'}</code></div>)}</div></> : <Empty title="Waiting for ChatGPT" copy="The validated result will appear here when it is ready." />}</section></aside></div></div>;
}

function SourceControl({ repositories, selectedRepositoryPath, commitMessage, onCommitMessageChange, onRefresh, onAdd, onCommit, onStage, onUnstage }: { repositories: Repository[]; selectedRepositoryPath: string; commitMessage: string; onCommitMessageChange: (message: string) => void; onRefresh: (path?: string) => Promise<AnyRecord | null>; onAdd: () => void; onCommit: (repositoryPath: string, message: string) => Promise<void>; onStage: (repositoryPath: string, file: string) => Promise<void>; onUnstage: (repositoryPath: string, file: string) => Promise<void> }) {
  const [selected, setSelected] = useState(selectedRepositoryPath || repositories[0]?.path || '');
  const [status, setStatus] = useState<AnyRecord | null>(null);
  const [selectedChange, setSelectedChange] = useState<{ change: AnyRecord; staged: boolean } | null>(null);
  const [diff, setDiff] = useState<AnyRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState('');
  const changes: AnyRecord[] = status?.changes || [];
  const stagedChanges = changes.filter((change) => Boolean(change.staged));
  const unstagedChanges = changes.filter((change) => Boolean(change.unstaged));
  const activeRepository = repositories.find((repository) => repository.path === selected) || status?.repository;
  const selectionKey = selectedChange ? `${selectedChange.staged ? 'staged' : 'unstaged'}:${selectedChange.change.path}` : '';

  const preview = useCallback(async (change: AnyRecord, staged: boolean) => {
    setSelectedChange({ change, staged });
    setDiff(null);
    setDiffLoading(true);
    setError('');
    try {
      setDiff(await call<AnyRecord>('gitDiff', selected, change.path, staged));
    } catch (previewError) {
      setError(errorMessage(previewError));
    } finally {
      setDiffLoading(false);
    }
  }, [selected]);

  const refreshSelected = useCallback(async () => {
    if (!selected) return null;
    setLoading(true);
    setError('');
    try {
      const nextStatus = await onRefresh(selected);
      setStatus(nextStatus);
      return nextStatus;
    } catch (refreshError) {
      setError(errorMessage(refreshError));
      return null;
    } finally {
      setLoading(false);
    }
  }, [selected, onRefresh]);

  useEffect(() => { refreshSelected(); }, [refreshSelected]);
  useEffect(() => { if (!selected && repositories[0]) setSelected(repositories[0].path); }, [repositories, selected]);
  useEffect(() => { if (selectedRepositoryPath && repositories.some((repository) => repository.path === selectedRepositoryPath)) setSelected(selectedRepositoryPath); }, [repositories, selectedRepositoryPath]);
  useEffect(() => { setSelectedChange(null); setDiff(null); }, [selected]);

  const runAction = async (action: () => Promise<unknown>) => {
    setActionBusy(true);
    setError('');
    try {
      await action();
      setSelectedChange(null);
      setDiff(null);
      await refreshSelected();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setActionBusy(false);
    }
  };
  const summarize = async () => {
    setSummaryBusy(true);
    setError('');
    try {
      const result = await call<AnyRecord>('gitSummary', selected, null);
      onCommitMessageChange(result.commitMessage || '');
    } catch (summaryError) {
      setError(errorMessage(summaryError));
    } finally {
      setSummaryBusy(false);
    }
  };
  const commit = async () => {
    if (!commitMessage.trim() || !status?.stagedCount) return;
    await runAction(async () => {
      await onCommit(selected, commitMessage);
      onCommitMessageChange('');
    });
  };
  const fileName = (filePath: string) => filePath.split('/').pop() || filePath;
  const directoryName = (filePath: string) => filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const changeRows = (items: AnyRecord[], staged: boolean) => items.map((change) => {
    const key = `${staged ? 'staged' : 'unstaged'}:${change.path}`;
    return <div className={`source-file-row ${selectionKey === key ? 'active' : ''}`} key={key}>
      <button type="button" className="source-file-open" onClick={() => preview(change, staged)}>
        <span className={`source-file-status ${change.untracked ? 'untracked' : staged ? 'staged' : ''}`}>{change.untracked ? 'U' : (staged ? change.indexStatus : change.worktreeStatus) || 'M'}</span>
        <span className="source-file-name"><strong>{fileName(change.path)}</strong>{directoryName(change.path) && <small>{directoryName(change.path)}</small>}</span>
      </button>
      <button type="button" className="source-file-action" disabled={actionBusy} aria-label={`${staged ? 'Unstage' : 'Stage'} ${change.path}`} title={staged ? 'Unstage changes' : 'Stage changes'} onClick={() => runAction(() => staged ? onUnstage(selected, change.path) : onStage(selected, change.path))}>{staged ? '−' : '+'}</button>
    </div>;
  });

  const additions = (diff?.rows || []).filter((row: AnyRecord) => row.afterType === 'added').length;
  const deletions = (diff?.rows || []).filter((row: AnyRecord) => row.beforeType === 'removed').length;
  return <div className="page-source">
    {repositories.length === 0 ? <div className="source-empty"><Empty title="No repositories" copy="Add a Git repository to review its local changes." action={<Button onClick={onAdd}>Add repository</Button>} /></div> : <>
      <div className="source-toolbar">
        <div className="source-repository-picker"><Icon>⌘</Icon><select aria-label="Repository" value={selected} onChange={(event) => setSelected(event.target.value)}>{repositories.map((repository) => <option value={repository.path} key={repository.path}>{repository.name || repository.path}</option>)}</select></div>
        <span className="source-branch"><Icon>⑂</Icon>{status?.repository?.branch || activeRepository?.branch || 'No branch'}</span>
        <span className="source-toolbar-spacer" />
        <Button variant="ghost" onClick={onAdd}>＋ Add repository</Button>
        <Button variant="ghost" disabled={loading} onClick={refreshSelected} aria-label="Refresh source control">{loading ? <i className="mini-spinner" aria-hidden="true" /> : '↻'} Refresh</Button>
      </div>
      <div className="source-workspace source-grid">
        <aside className="source-changes-pane">
          <div className="source-pane-heading"><div><h2>Changes</h2><span>{changes.length} file{changes.length === 1 ? '' : 's'}</span></div></div>
          {error && <div className="source-error" role="alert">{error}</div>}
          <div className="source-file-list">
            <section className="source-change-group">
              <header><strong>Changes</strong><span>{unstagedChanges.length}</span>{unstagedChanges.length > 0 && <button type="button" disabled={actionBusy} onClick={() => runAction(() => call('gitStageAll', selected))}>Stage all</button>}</header>
              {changeRows(unstagedChanges, false)}
              {!loading && unstagedChanges.length === 0 && <p>{stagedChanges.length ? 'All changes are staged.' : 'No local changes.'}</p>}
            </section>
            <section className="source-change-group">
              <header><strong>Staged changes</strong><span>{stagedChanges.length}</span>{stagedChanges.length > 0 && <button type="button" disabled={actionBusy} onClick={() => runAction(() => call('gitUnstageAll', selected))}>Unstage all</button>}</header>
              {changeRows(stagedChanges, true)}
              {!loading && stagedChanges.length === 0 && <p>No staged changes.</p>}
            </section>
          </div>
          <div className="source-commit-composer">
            <textarea rows={3} value={commitMessage} onChange={(event) => onCommitMessageChange(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commit(); } }} placeholder="Commit message" aria-label="Commit message" />
            <div className="source-commit-actions"><Button variant="ghost" disabled={summaryBusy || changes.length === 0} onClick={summarize}>{summaryBusy ? <><i className="mini-spinner" aria-hidden="true" /> Writing…</> : '✦ AI summary'}</Button><Button variant="primary" aria-label="Commit staged changes" disabled={actionBusy || !commitMessage.trim() || !status?.stagedCount} onClick={commit}>Commit</Button></div>
            <small>{status?.stagedCount ? `${status.stagedCount} staged file${status.stagedCount === 1 ? '' : 's'} · ⌘↵ to commit` : 'Stage changes to commit'}</small>
          </div>
        </aside>
        <section className="source-diff-pane" aria-label="Change review">
          {selectedChange ? <>
            <header className="source-diff-heading"><div><strong>{selectedChange.change.path}</strong><span>{selectedChange.staged ? 'Staged changes' : selectedChange.change.label || 'Working tree changes'}</span></div>{diff && !diff.binary && <div className="source-diff-stats"><span className="diff-additions">+{additions}</span><span className="diff-deletions">−{deletions}</span></div>}</header>
            {diffLoading ? <div className="source-review-empty"><i className="mini-spinner" aria-hidden="true" /><span>Loading changes…</span></div> : diff?.binary ? <div className="source-review-empty"><strong>Preview unavailable</strong><span>{diff.content}</span></div> : diff?.rows?.length ? <div className="split-diff"><div className="split-diff-labels"><span>{diff.beforeLabel}</span><span>{diff.afterLabel}</span></div>{diff.rows.map((row: AnyRecord, index: number) => <div className="split-diff-row" key={index}><div className={`split-diff-cell ${row.beforeType}`}><span>{row.beforeNumber ?? ''}</span><code>{row.beforeText || ' '}</code></div><div className={`split-diff-cell ${row.afterType}`}><span>{row.afterNumber ?? ''}</span><code>{row.afterText || ' '}</code></div></div>)}{diff.truncated && <div className="diff-truncated">Large diff truncated for display.</div>}</div> : <div className="source-review-empty"><strong>No textual changes</strong><span>{diff?.content || 'This file has no previewable diff.'}</span></div>}
          </> : <div className="source-review-empty"><span className="source-review-icon">⑂</span><strong>{changes.length ? 'Select a file to review changes' : 'Working tree clean'}</strong><span>{changes.length ? 'Choose a staged or unstaged file from the Changes list.' : 'There are no local changes in this repository.'}</span></div>}
        </section>
      </div>
    </>}
  </div>;
}

function Trees({ trees, projects, repositories, onRefresh, onCreate, onRemove, onMerge, onReveal, onNewTask, onResolve }: { trees: Tree[]; projects: AnyRecord[]; repositories: Repository[]; onRefresh: () => void; onCreate: () => void; onRemove: (id: string) => void; onMerge: (id: string, project: AnyRecord | null) => void; onReveal: (id: string) => void; onNewTask: (tree: Tree) => void; onResolve: (tree: Tree) => void }) {
  const [project, setProject] = useState('');
  return <div className="page"><div className="workspace-heading"><div><div className="eyebrow">WORKTREES</div><h2>Coding trees</h2><p>Keep independent tasks isolated until you are ready to merge them.</p></div><div className="heading-actions"><select value={project} onChange={(e) => setProject(e.target.value)}><option value="">Default ChatGPT project</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><Button variant="primary" onClick={onCreate} disabled={repositories.length === 0}>＋ New coding tree</Button><Button onClick={onRefresh}>↻ Refresh</Button></div></div>{trees.length ? <div className="tree-grid">{trees.map((tree) => <article className="tree-card" key={tree.id}><div className="tree-card-heading"><span className="repo-icon">⑃</span><div><h3>{tree.name || tree.id}</h3><small>{tree.path}</small></div><span className={`status-badge ${tree.mergeState || tree.state || 'ready'}`}>{tree.mergeState || tree.state || 'ready'}</span></div><div className="tree-stats"><span><strong>{tree.taskCount || 0}</strong><small>Tasks</small></span><span><strong>{tree.commitCount || 0}</strong><small>Commits</small></span></div><div className="tree-actions"><Button onClick={() => onReveal(tree.id)}>Open folder</Button><Button onClick={() => onNewTask(tree)}>＋ Continue task</Button>{tree.mergeState === 'failed' ? <Button onClick={() => onResolve(tree)}>Resolve merge</Button> : <Button onClick={() => onMerge(tree.id, projects.find((item) => item.id === project) || null)}>Merge tree</Button>}<Button variant="danger" onClick={() => onRemove(tree.id)}>Discard</Button></div></article>)}</div> : <Empty title="No coding trees" copy="Create one here or from the New Task workspace." action={repositories.length > 0 ? <Button variant="primary" onClick={onCreate}>Create coding tree</Button> : undefined} />}</div>;
}

function TreeCreateDialog({ repositories, onClose, onCreate }: { repositories: Repository[]; onClose: () => void; onCreate: (repositoryPath: string, treeName: string) => Promise<void> }) {
  const [repositoryPath, setRepositoryPath] = useState(repositories[0]?.path || '');
  const [treeName, setTreeName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!repositoryPath || !treeName.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onCreate(repositoryPath, treeName.trim());
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return <Modal title="Create coding tree" eyebrow="WORKTREES" onClose={onClose}>
    <form onSubmit={submit}>
      {repositories.length === 0 ? <Empty title="No repositories" copy="Add a Git repository before creating a coding tree." /> : <>
        <label>Repository<select value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)}>{repositories.map((repository) => <option value={repository.path} key={repository.path}>{repository.name || repository.path}</option>)}</select></label>
        <label>Name<input value={treeName} onChange={(event) => setTreeName(event.target.value)} maxLength={80} placeholder="Feature name" autoFocus /></label>
        <p className="dialog-copy">The tree starts from the repository's current commit on its current branch. The source repository must have a commit, be on a branch, and have no local changes.</p>
      </>}
      {error && <div className="form-error">{error}</div>}
      <div className="dialog-footer"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || repositories.length === 0 || !repositoryPath || !treeName.trim()}>{busy ? 'Creating…' : 'Create tree'}</Button></div>
    </form>
  </Modal>;
}

function History({ tasks, onOpen, onDelete }: { tasks: Task[]; onOpen: (task: Task) => void; onDelete: (task: Task) => void }) { const [search, setSearch] = useState(''); const visible = tasks.filter((task) => `${task.taskText} ${task.state} ${task.treeName || ''}`.toLowerCase().includes(search.toLowerCase())); return <div className="page"><div className="workspace-heading"><div><div className="eyebrow">HISTORY</div><h2>Task history</h2><p>Every prepared task remains available for review and recovery.</p></div><input className="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks" /></div><div className="history-list">{visible.map((task) => <article className="history-row" key={task.taskId}><div><h3>{firstLine(task.taskText)}</h3><p>{formatDate(task.createdAt)} · {task.treeName || 'Current repository'}</p><span>{task.result?.summary || task.error || 'No result summary recorded.'}</span></div><div className="history-actions"><span className={`status-badge ${task.state}`}>{statusLabel(task)}</span><Button onClick={() => onOpen(task)}>View</Button><Button variant="danger" onClick={() => onDelete(task)}>Delete</Button></div></article>)}{visible.length === 0 && <Empty title="No matching tasks" copy="Try a different search." />}</div></div>; }

function PromptDialog({ onClose, selected, onSelection }: { onClose: () => void; selected: string[]; onSelection: (ids: string[]) => void }) { const [name, setName] = useState(''); const [content, setContent] = useState(''); const [saved, setSaved] = useState<AnyRecord[]>(() => { try { return JSON.parse(localStorage.getItem('patchwork.prompt-library') || '[]'); } catch { return []; } }); const save = () => { if (!name.trim() || !content.trim()) return; const next = [{ id: `prompt-${Date.now()}`, name: name.trim(), content: content.trim(), description: '' }, ...saved].slice(0, 100); setSaved(next); localStorage.setItem('patchwork.prompt-library', JSON.stringify(next)); setName(''); setContent(''); }; return <Modal title="Prompt library" eyebrow="REUSABLE INSTRUCTIONS" onClose={onClose} wide><div className="dialog-grid"><div><label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="UI review" /></label><label>Instructions<textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} placeholder="Additional instructions for coding tasks" /></label><Button variant="primary" onClick={save}>Save prompt</Button></div><div className="saved-list">{saved.map((prompt) => <label className="skill-row" key={prompt.id}><input type="checkbox" checked={selected.includes(prompt.id)} onChange={(e) => onSelection(e.target.checked ? [...selected, prompt.id] : selected.filter((id) => id !== prompt.id))} /><span><strong>{prompt.name}</strong><small>{prompt.content}</small></span></label>)}{saved.length === 0 && <Empty title="No saved prompts" />}</div></div></Modal>; }
function SkillsDialog({ onClose, selected, onSelection, repositoryPaths }: { onClose: () => void; selected: string[]; onSelection: (ids: string[]) => void; repositoryPaths: string[] }) { const [skills, setSkills] = useState<AnyRecord[]>([]); useEffect(() => { call<AnyRecord[]>('listSkills', repositoryPaths).then(setSkills).catch(() => {}); }, [repositoryPaths.join('|')]); return <Modal title="Choose skills" eyebrow="TASK CONFIGURATION" onClose={onClose}><p className="dialog-copy">Select local skills to make available to this task package.</p><div className="skill-list">{skills.map((skill) => { const id = skill.id || skill.name; return <label className="skill-row" key={id}><input type="checkbox" checked={selected.includes(id)} onChange={(e) => onSelection(e.target.checked ? [...selected, id] : selected.filter((item) => item !== id))} /><span><strong>{skill.name}</strong><small>{skill.description || skill.location}</small></span></label>; })}{skills.length === 0 && <Empty title="No skills discovered" copy="Skills with a SKILL.md file appear here." />}</div><div className="dialog-footer"><Button variant="primary" onClick={onClose}>Done</Button></div></Modal>; }
function ConflictDialog({ task, onClose, onSubmit }: { task: Task; onClose: () => void; onSubmit: (instructions: string) => void }) { const [instructions, setInstructions] = useState(''); return <Modal title="Resolve conflict with ChatGPT" eyebrow="CONFLICT RESOLUTION" onClose={onClose}><p className="dialog-copy">Patchwork will create a follow-up task with the current target and the failed result.</p><label>Additional instructions<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={7} placeholder="Preserve both sides and verify the final diff." /></label><div className="dialog-footer"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSubmit(instructions)}>Resolve conflict</Button></div></Modal>; }

export default function App() {
  const [route, setRoute] = useState<Route>('home');
  const [collapsed, setCollapsedState] = useState(() => localStorage.getItem('patchwork.sidebar-collapsed') === 'true');
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem('patchwork.theme') as Theme) || 'system');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [trees, setTrees] = useState<Tree[]>([]);
  const [projects, setProjects] = useState<AnyRecord[]>([]);
  const [iacConfig, setIacConfig] = useState<AnyRecord | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>(readCachedConversations);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [chatAwaitingReply, setChatAwaitingReply] = useState(false);
  const [chatHistoryError, setChatHistoryError] = useState('');
  const [chatThreadError, setChatThreadError] = useState('');
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [taskConversation, setTaskConversation] = useState<Chat | null>(null);
  const [taskConversationLoading, setTaskConversationLoading] = useState(false);
  const [taskConversationError, setTaskConversationError] = useState('');
  const [activityByTask, setActivityByTask] = useState<Record<string, TaskActivity[]>>(readCachedTaskActivity);
  const [sourceRepositoryPath, setSourceRepositoryPath] = useState('');
  const [sourceCommitMessage, setSourceCommitMessage] = useState('');
  const [chatModel, setChatModel] = useState(localStorage.getItem('patchwork.chat-model') || 'sol');
  const [promptIds, setPromptIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<AnyRecord[]>([]);
  const [preferredTreeId, setPreferredTreeId] = useState<string>();
  const [sessionStatus, setSessionStatus] = useState<AnyRecord>({ authenticated: false, open: false });
  const [toast, setToast] = useState<Toast>(null);
  const [dialog, setDialog] = useState<'prompts' | 'skills' | 'conflict' | 'tree-create' | null>(null);
  const repositoryPaths = useMemo(() => repositories.map((repository) => repository.path), [repositories]);

  useEffect(() => { document.body.classList.add(platformClass); return () => document.body.classList.remove(platformClass); }, []);
  useEffect(() => { bridge.setAppearanceTheme?.(theme); }, [theme]);
  useEffect(() => { persistTaskActivity(activityByTask); }, [activityByTask]);

  const setCollapsed = (value: boolean) => { setCollapsedState(value); localStorage.setItem('patchwork.sidebar-collapsed', String(value)); };
  const setTheme = (value: Theme) => { setThemeState(value); localStorage.setItem('patchwork.theme', value); };
  const notify = useCallback((message: string, error = false) => { setToast({ message, error }); window.setTimeout(() => setToast(null), 5000); }, []);
  const rememberConversation = useCallback((chat: Chat) => {
    if (!chat.id || chat.id.startsWith('pending-')) return;
    setConversations((items) => {
      const previous = items.find((item) => item.id === chat.id);
      const next = [{ ...previous, id: chat.id, title: chat.title || previous?.title || 'New chat', updateTime: chat.updateTime || Date.now(), status: chat.status }, ...items.filter((item) => item.id !== chat.id)];
      persistConversations(next);
      return next;
    });
  }, []);
  const conversationIsWorking = useCallback((chat: Chat | null) => {
    return chat?.status === 'streaming';
  }, []);
  const appendTaskActivity = useCallback((taskId: string, event: AnyRecord) => {
    if (!taskId || !event.message) return;
    setActivityByTask((current) => {
      const entries = current[taskId] || [];
      const type = text(event.type, 'update');
      const message = text(event.message);
      const last = entries.at(-1);
      if (last?.type === type && last.message === message) return current;
      const entry: TaskActivity = { id: text(event.id, `${taskId}-${type}-${Date.now()}`), taskId, type, message, createdAt: Number(event.createdAt || Date.now()) };
      return { ...current, [taskId]: [...entries, entry].slice(-100) };
    });
  }, []);
  const refresh = useCallback(async () => { try { const [nextTasks, nextRepos, nextTrees] = await Promise.all([call<Task[]>('listTasks'), call<Repository[]>('listWorkspaceRepositories'), call<Tree[]>('listTrees')]); setTasks(nextTasks || []); setRepositories((nextRepos || []).filter((item) => !item.unavailable)); setTrees(nextTrees || []); } catch (e) { notify(errorMessage(e), true); } }, [notify]);
  const refreshProjects = useCallback(async () => { try { setProjects(await call<AnyRecord[]>('listChatGPTProjects')); } catch { /* sign-in is optional until needed */ } }, []);
  const refreshIacConfig = useCallback(async () => { try { setIacConfig(await call<AnyRecord>('getIacConfig')); } catch (e) { setIacConfig({ exists: false, valid: false, selectors: [], error: errorMessage(e), settingsPath: 'settings.json' }); } }, []);
  const refreshConversationList = useCallback(async (showError = true) => {
    try {
      const items = await call<Conversation[]>('listChatConversations');
      setConversations(items || []);
      persistConversations(items || []);
      setChatHistoryError('');
    } catch (e) {
      const message = errorMessage(e);
      setChatHistoryError(message);
      if (showError) notify(message, true);
    }
  }, [notify]);
  const refreshSessionStatus = useCallback(async () => { try { setSessionStatus(await call<AnyRecord>('getSessionStatus')); } catch { setSessionStatus({ authenticated: false, open: false }); } }, []);

  useEffect(() => {
    refresh();
    refreshProjects();
    refreshIacConfig();
    refreshConversationList(false);
    refreshSessionStatus();
    const unsubscribe = bridge.onTaskEvent?.((event) => {
      if (event.task) {
        setTasks((items) => { const index = items.findIndex((item) => item.taskId === event.task.taskId); if (index < 0) return [event.task, ...items]; const next = [...items]; next[index] = event.task; return next; });
        setActiveTask((current) => current?.taskId === event.task.taskId ? event.task : current);
      }
      const taskId = text(event.task?.taskId || event.taskId);
      if (taskId && event.message) appendTaskActivity(taskId, event);
      if (event.type === 'task-deleted') setTasks((items) => items.filter((item) => item.taskId !== event.taskId));
      if (String(event.type || '').startsWith('session-')) refreshSessionStatus();
      if (event.type === 'tree-created' || event.type === 'tree-removed' || event.type === 'tree-merged') refresh();
      if (event.message && /(failed|conflict|ready|applied|rolled-back)/i.test(text(event.type))) notify(event.message, /failed|conflict/i.test(text(event.type)));
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [appendTaskActivity, notify, refresh, refreshConversationList, refreshIacConfig, refreshProjects, refreshSessionStatus]);

  useEffect(() => {
    const id = activeChat?.id;
    if (route !== 'chat' || !id || id.startsWith('pending-') || !chatAwaitingReply) return;
    let disposed = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await call<Chat>('getChatConversation', id);
        if (disposed) return;
        setActiveChat((current) => current?.id === id ? next : current);
        rememberConversation(next);
        setChatThreadError('');
        setChatAwaitingReply(conversationIsWorking(next));
      } catch (e) {
        if (!disposed) setChatThreadError(`${errorMessage(e)} Retrying automatically…`);
      } finally {
        busy = false;
      }
    };
    poll();
    const timer = window.setInterval(poll, 1800);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [activeChat?.id, chatAwaitingReply, conversationIsWorking, rememberConversation, route]);

  const loadTaskConversation = useCallback(async (conversationId: string, showLoading = false) => {
    if (showLoading) setTaskConversationLoading(true);
    try {
      const next = await call<Chat>('getChatConversation', conversationId);
      setTaskConversation(next);
      setTaskConversationError('');
      return next;
    } catch (e) {
      setTaskConversationError(`${errorMessage(e)}${showLoading ? '' : ' Retrying automatically…'}`);
      return null;
    } finally {
      if (showLoading) setTaskConversationLoading(false);
    }
  }, []);

  useEffect(() => {
    const conversationId = activeTask?.conversationId;
    if (route !== 'task' || !conversationId) {
      setTaskConversation(null);
      setTaskConversationError('');
      return;
    }
    let disposed = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await call<Chat>('getChatConversation', conversationId);
        if (!disposed) { setTaskConversation(next); setTaskConversationError(''); }
      } catch (e) {
        if (!disposed) setTaskConversationError(`${errorMessage(e)} Retrying automatically…`);
      } finally {
        busy = false;
      }
    };
    poll();
    const working = activeTask?.state === 'submitted' || activeTask?.chatStatus === 'streaming';
    const timer = working ? window.setInterval(poll, 2000) : null;
    return () => { disposed = true; if (timer) window.clearInterval(timer); };
  }, [activeTask?.chatStatus, activeTask?.conversationId, activeTask?.state, route]);

  const updateTask = (task: Task) => { setActiveTask(task); setTasks((items) => [task, ...items.filter((item) => item.taskId !== task.taskId)]); };
  const createTask = async (input: AnyRecord) => { let savedPrompts: AnyRecord[] = []; try { savedPrompts = JSON.parse(localStorage.getItem('patchwork.prompt-library') || '[]'); } catch { savedPrompts = []; } const selectedPrompts = savedPrompts.filter((prompt) => input.promptIds?.includes(prompt.id)).map((prompt) => String(prompt.content || '').trim()).filter(Boolean); const taskText = selectedPrompts.length ? `${input.taskText}\n\n## Additional saved prompt instructions\n\n${selectedPrompts.join('\n\n')}` : input.taskText; const { promptIds: _promptIds, ...request } = input; const task = await call<Task>('createTask', { ...request, taskText }); updateTask(task); appendTaskActivity(task.taskId, { type: 'task-prepared', message: 'Prepared the task package for ChatGPT.' }); setPreferredTreeId(undefined); setRoute('task'); window.setTimeout(() => { call<Task>('submitTask', task.taskId).then((submitted) => updateTask(submitted)).catch((e) => notify(errorMessage(e), true)); }, 400); };
  const addRepositories = async () => { try { const selected = await call<Repository[]>('chooseRepositories'); if (selected?.length) { setRepositories((items) => [...selected, ...items.filter((item) => !selected.some((next) => next.path === item.path))]); notify(`${selected.length} repository added.`); } } catch (e) { notify(errorMessage(e), true); } };
  const openTask = (task: Task) => { setActiveTask(task); setTaskConversation(null); setRoute('task'); };
  const taskAction = async (name: string) => { if (!activeTask) return; try { const result = name === 'openChatInSession' ? await call<boolean>('openChatInSession', activeTask.conversationId || null) : await call<Task>(name, activeTask.taskId); if (result && typeof result === 'object' && result.taskId) { setActiveTask(result); setTasks((items) => items.map((item) => item.taskId === result.taskId ? result : item)); if (name === 'useGitSummary') { setSourceRepositoryPath(text(result.sourceRepositoryPath || result.repositories?.[0]?.path)); setSourceCommitMessage(text(result.result?.commitMessage)); setRoute('source'); } } if (name === 'openChatInSession') notify('Opened ChatGPT session.'); } catch (e) { notify(errorMessage(e), true); } };
  const sendChat = async (message: string, chatAttachments: AnyRecord[], reasoningMode: string) => {
    const previous = activeChat;
    const pendingId = activeChat?.id || `pending-${Date.now()}`;
    const optimistic: Chat = { ...(activeChat || { id: pendingId, title: 'New chat' }), status: 'streaming', updateTime: Date.now(), messages: [...(activeChat?.messages || []), { id: `pending-message-${Date.now()}`, role: 'user', text: message, kind: 'message' }] };
    setActiveChat(optimistic);
    setChatAwaitingReply(true);
    setChatThreadError('');
    try {
      const result = await call<AnyRecord>('sendChatMessage', { conversationId: previous?.id || null, message, model: chatModel, reasoningMode, attachments: chatAttachments });
      const accepted: Chat = { ...optimistic, id: result.conversationId, url: result.conversationUrl, status: 'streaming', updateTime: Date.now() };
      setActiveChat(accepted);
      rememberConversation(accepted);
    } catch (e) {
      setActiveChat(previous);
      setChatAwaitingReply(conversationIsWorking(previous));
      throw e;
    }
  };
  const openChat = async (id: string) => {
    setChatThreadError('');
    try {
      const next = await call<Chat>('getChatConversation', id);
      setActiveChat(next);
      setChatAwaitingReply(conversationIsWorking(next));
      rememberConversation(next);
    } catch (e) {
      setChatThreadError(errorMessage(e));
      notify(errorMessage(e), true);
    }
  };
  const stopChat = async () => {
    await call('stopChatResponse');
    setChatAwaitingReply(false);
    setActiveChat((current) => current ? { ...current, status: 'unknown' } : current);
    const id = activeChat?.id;
    if (id && !id.startsWith('pending-')) window.setTimeout(() => openChat(id), 500);
  };
  const refreshChatSurface = async () => {
    const id = activeChat?.id;
    const detail = id && !id.startsWith('pending-') ? openChat(id) : Promise.resolve();
    await Promise.allSettled([refreshConversationList(true), detail]);
  };
  const newChat = () => { setActiveChat(null); setChatAwaitingReply(false); setChatThreadError(''); setRoute('chat'); };
  const openSession = async () => { try { await call('openSession', activeChat?.id?.startsWith('pending-') ? null : activeChat?.id || null); await refreshSessionStatus(); } catch (e) { notify(errorMessage(e), true); } };
  const resetAuthentication = async () => { if (!window.confirm('Clear Patchwork’s ChatGPT sign-in data and start a fresh login? Tasks and repositories will not be affected.')) return; try { await call('resetSessionAuthentication'); await refreshSessionStatus(); notify('ChatGPT sign-in data was cleared.'); } catch (e) { notify(errorMessage(e), true); } };
  const setTaskTarget = async (treeId: string | null) => { if (!activeTask) return; try { const task = await call<Task>('setTaskTarget', activeTask.taskId, { treeId }); updateTask(task); notify(treeId ? 'Task target updated.' : 'Task will apply to the original repository.'); } catch (e) { notify(errorMessage(e), true); } };
  const createTree = async (repositoryPath: string, treeName: string) => { const tree = await call<Tree>('createTree', { repositoryPath, treeName }); setTrees((items) => [tree, ...items.filter((item) => item.id !== tree.id)]); notify(`Created coding tree ${tree.name || tree.id}.`); };
  const routeTitle = route === 'home' ? 'Home' : route === 'chat' ? 'Chat' : route === 'source' ? 'Source control' : route === 'trees' ? 'Coding trees' : route === 'history' ? 'Task history' : 'Task';

  return <div className={`app ${theme === 'system' ? 'theme-system' : `theme-${theme}`}`}><Sidebar route={route} onRoute={setRoute} onTaskSelect={openTask} collapsed={collapsed} setCollapsed={setCollapsed} tasks={tasks} conversations={conversations} onNewTask={() => { setActiveTask(null); setPreferredTreeId(undefined); setRoute('home'); }} onNewChat={newChat} theme={theme} setTheme={setTheme} authenticated={Boolean(sessionStatus.authenticated)} onOpenSession={openSession} onResetAuthentication={resetAuthentication} /><main className="main"><Header title={routeTitle} onToggleSidebar={() => setCollapsed(!collapsed)} right={route === 'chat' ? <><Button variant="ghost" onClick={openSession}>Open ChatGPT</Button><Button variant="ghost" onClick={refreshChatSurface}>↻ Refresh</Button></> : null} />{route === 'home' && <Home repositories={repositories} trees={trees} projects={projects} iacConfig={iacConfig} promptIds={promptIds} skillIds={skillIds} attachments={attachments} setAttachments={setAttachments} preferredTreeId={preferredTreeId} onAddRepository={addRepositories} onCreateTask={createTask} onOpenSkills={() => setDialog('skills')} onOpenPrompts={() => setDialog('prompts')} />}{route === 'chat' && <ChatWorkspace conversations={conversations} activeChat={activeChat} awaitingReply={chatAwaitingReply} historyError={chatHistoryError} threadError={chatThreadError} onSelect={openChat} onRefresh={refreshChatSurface} onNew={newChat} onSend={sendChat} onStop={stopChat} model={chatModel} setModel={(value) => { setChatModel(value); localStorage.setItem('patchwork.chat-model', value); }} />}{route === 'task' && <TaskDetail task={activeTask} trees={trees} conversation={taskConversation} conversationLoading={taskConversationLoading} conversationError={taskConversationError} activity={activeTask ? activityByTask[activeTask.taskId] || [] : []} onAction={taskAction} onConflict={() => setDialog('conflict')} onSetTarget={setTaskTarget} onRefreshConversation={() => { if (activeTask?.conversationId) loadTaskConversation(activeTask.conversationId, true); }} onDelete={async () => { if (activeTask) { await call('deleteTask', activeTask.taskId); setTasks((items) => items.filter((item) => item.taskId !== activeTask.taskId)); setActiveTask(null); setRoute('history'); } }} />}{route === 'source' && <SourceControl repositories={repositories} selectedRepositoryPath={sourceRepositoryPath} commitMessage={sourceCommitMessage} onCommitMessageChange={setSourceCommitMessage} onRefresh={(path) => call<AnyRecord>('gitStatus', path || repositories[0]?.path)} onAdd={addRepositories} onCommit={async (path, message) => { await call('gitCommit', path, message); notify('Commit created.'); }} onStage={async (path, file) => { await call('gitStage', path, [file]); }} onUnstage={async (path, file) => { await call('gitUnstage', path, [file]); }} />}{route === 'trees' && <Trees trees={trees} projects={projects} repositories={repositories} onRefresh={() => refresh()} onCreate={() => setDialog('tree-create')} onRemove={async (id) => { await call('removeTree', id); refresh(); }} onMerge={async (id, project) => { await call('mergeTree', id, project); notify('Merge submitted.'); }} onReveal={(id) => call('revealTree', id)} onNewTask={(tree) => { setPreferredTreeId(tree.id); notify(`Continuing in ${tree.name || 'coding tree'}.`); setRoute('home'); }} onResolve={async (tree) => { await call('resolveTreeMerge', tree.id); notify('Merge resolution submitted.'); }} />}{route === 'history' && <History tasks={tasks} onOpen={openTask} onDelete={async (task) => { await call('deleteTask', task.taskId); setTasks((items) => items.filter((item) => item.taskId !== task.taskId)); }} />}</main>{dialog === 'prompts' && <PromptDialog selected={promptIds} onSelection={setPromptIds} onClose={() => setDialog(null)} />}{dialog === 'skills' && <SkillsDialog selected={skillIds} onSelection={setSkillIds} repositoryPaths={repositoryPaths} onClose={() => setDialog(null)} />}{dialog === 'conflict' && activeTask && <ConflictDialog task={activeTask} onClose={() => setDialog(null)} onSubmit={(instructions) => { call('resolveTaskConflict', activeTask.taskId, { additionalInstructions: instructions, model: activeTask.model || 'default', reasoningMode: activeTask.reasoningMode || 'default' }).then(() => { setDialog(null); notify('Conflict resolution submitted.'); }).catch((e) => notify(errorMessage(e), true)); }} />}{dialog === 'tree-create' && <TreeCreateDialog repositories={repositories} onClose={() => setDialog(null)} onCreate={createTree} />}{toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status">{toast.message}</div>}</div>;
}

createRoot(document.getElementById('root')!).render(<App />);
