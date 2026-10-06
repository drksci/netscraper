/** Minimal node:events EventEmitter for the in-browser actor build (only what the runtime uses). */
type Fn = (...a: any[]) => void;
export class EventEmitter {
  private _ev = new Map<string | symbol, Fn[]>();
  on(e: string | symbol, fn: Fn) { (this._ev.get(e) ?? this._ev.set(e, []).get(e)!).push(fn); return this; }
  addListener(e: string | symbol, fn: Fn) { return this.on(e, fn); }
  once(e: string | symbol, fn: Fn) { const w = (...a: any[]) => { this.off(e, w); fn(...a); }; return this.on(e, w); }
  off(e: string | symbol, fn: Fn) { const l = this._ev.get(e); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; }
  removeListener(e: string | symbol, fn: Fn) { return this.off(e, fn); }
  removeAllListeners(e?: string | symbol) { if (e === undefined) this._ev.clear(); else this._ev.delete(e); return this; }
  listeners(e: string | symbol) { return [...(this._ev.get(e) ?? [])]; }
  listenerCount(e: string | symbol) { return this._ev.get(e)?.length ?? 0; }
  setMaxListeners() { return this; }
  emit(e: string | symbol, ...a: any[]) {
    const l = this._ev.get(e);
    if (!l?.length) return false;
    for (const fn of [...l]) fn.apply(this, a);
    return true;
  }
}
export default EventEmitter;
