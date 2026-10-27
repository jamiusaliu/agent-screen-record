import { ScreenrecError } from '../../core/errors.ts';

export interface TabInfo { targetId: string; url: string; title: string }
export type TabMode = 'newest' | 'follow' | 'url' | 'title';

export class TabTracker {
  private tabs = new Map<string, TabInfo>();
  private agent: string[] = [];          // agent tabs in creation order
  private focusOrder: string[] = [];     // follow: most recent creation or activation last
  private sticky: string | null = null;  // url/title mode

  constructor(private mode: TabMode, private pattern: string | undefined, existing: TabInfo[]) {
    if ((mode === 'url' || mode === 'title') && !pattern?.trim()) {
      throw new ScreenrecError('E_BAD_ARGS', `--tab ${mode}: needs a non-empty pattern`, `Pass a substring to match, for example --tab ${mode}:github.com`);
    }
    for (const e of existing) this.tabs.set(e.targetId, e);
  }

  private matches(t: TabInfo): boolean {
    const p = (this.pattern ?? '').toLowerCase();
    return (this.mode === 'url' ? t.url : t.title).toLowerCase().includes(p);
  }

  created(t: TabInfo): void {
    if (this.tabs.has(t.targetId)) { this.changed(t); return; }
    this.tabs.set(t.targetId, t);
    this.agent.push(t.targetId);
    this.focusOrder.push(t.targetId);
  }

  changed(t: TabInfo): void { if (this.tabs.has(t.targetId)) this.tabs.set(t.targetId, t); }

  destroyed(id: string): void {
    this.tabs.delete(id);
    this.agent = this.agent.filter((x) => x !== id);
    this.focusOrder = this.focusOrder.filter((x) => x !== id);
    if (this.sticky === id) this.sticky = null;
  }

  activated(id: string): void {
    if (this.mode !== 'follow' || !this.agent.includes(id)) return;
    this.focusOrder = [...this.focusOrder.filter((x) => x !== id), id];
  }

  current(): string | null {
    if (this.mode === 'newest') return this.agent.at(-1) ?? null;
    if (this.mode === 'follow') return this.focusOrder.at(-1) ?? null;
    if (this.sticky && this.tabs.has(this.sticky)) return this.sticky;
    const hit = [...this.tabs.values()].find((t) => this.matches(t));
    this.sticky = hit?.targetId ?? null;
    return this.sticky;
  }

  agentTabs(): string[] { return [...this.agent]; }

  label(id: string): string {
    const t = this.tabs.get(id);
    return t ? `${t.title || '(untitled)'} (${t.url})` : id;
  }
}
