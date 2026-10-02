import {meteredConnection,warmConnection as connection} from './warmNetwork';
import {onNetworkRestored,onPowerChange} from './deviceSignals';
import {onVisible} from './useVisibleInterval';
import type {WarmState} from './thumbnailWarm';
export const START_DELAY=30_000;
const IDLE_DELAY=3_000, POWER_FALLBACK=30*60_000, RETRY_AFTER=60_000;
type WarmSchedule={enabled():boolean;pass(signal:AbortSignal):Promise<boolean|void>;publish(state:WarmState):void;
  progress():{warmed:number;completedAt:number|null};repeatAfter:number;event:string;blocked?():boolean;wakeEvents?:string[]};
/** Shared visible, idle, power/network wake and retry policy for device cache warming. */
export function scheduleWarm(options:WarmSchedule) {
  const {enabled, pass, publish, progress:saved, repeatAfter, event}=options;
  let controller:AbortController|null = null, timer = 0, stopped = false, paused=false;
  let notBefore = Date.now() + START_DELAY, lastInteraction = Date.now();
  /** What the pending retry timer waits for; the matching native event ends the wait early. */
  let waiting:'power'|'network'|null = null;
  const halt = () => { controller?.abort(); controller = null; clearTimeout(timer); timer = 0; waiting = null; };
  const evaluate = () => {
    if (stopped) return;
    const progress = saved();
    if (!enabled()) { halt(); publish({status:'off', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    if (meteredConnection()) { halt(); publish({status:'metered', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    if (paused || document.visibilityState === 'hidden') { halt(); publish({status:'waiting', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    if (options.blocked?.()) { halt(); return; }
    if (controller || timer) return;
    waiting = null;
    const wait = Math.max(0, notBefore - Date.now(), lastInteraction + IDLE_DELAY - Date.now());
    timer = window.setTimeout(() => { timer = 0; begin(); }, wait);
  };
  const begin = () => {
    if (stopped || paused || controller || !enabled() || meteredConnection() || document.visibilityState === 'hidden' || options.blocked?.()) return;
    const current = controller = new AbortController();
    void pass(current.signal).then(allowed => {
      if (controller !== current) return;
      controller = null;
      // A finished pass checks again after the repeat interval while the app stays open.
      waiting = allowed === false ? 'power' : null;
      timer = window.setTimeout(() => { timer = 0; waiting = null; evaluate(); }, allowed===false?POWER_FALLBACK:repeatAfter);
    }, () => {
      if (controller !== current || current.signal.aborted) return;
      // A failed member of a parallel batch must release its still-running sibling.
      current.abort();
      controller = null; const progress = saved();
      publish({status:'error', warmed:progress.warmed, completedAt:progress.completedAt});
      waiting = 'network';
      timer = window.setTimeout(() => { timer = 0; waiting = null; evaluate(); }, RETRY_AFTER);
    });
  };
  const toggle = () => { halt(); notBefore = Date.now() + START_DELAY; lastInteraction = Date.now(); evaluate(); };
  const resume = () => { paused=false; halt(); notBefore = Date.now() + START_DELAY; lastInteraction = Date.now(); evaluate(); };
  const pause = () => { paused=true; halt(); };
  const interaction = () => {
    if (stopped) return;
    lastInteraction = Date.now();
    if (controller) halt(); else { clearTimeout(timer); timer = 0; waiting = null; }
    evaluate();
  };
  const wake = (kind:'power'|'network') => () => {
    if (stopped || waiting !== kind) return;
    clearTimeout(timer); timer = 0; waiting = null; evaluate();
  };
  for (const name of options.wakeEvents ?? []) window.addEventListener(name, interaction);
  const removePower = onPowerChange(()=>controller?interaction():wake('power')()), removeNetwork = onNetworkRestored(wake('network'));
  const removeVisible = onVisible(resume);
  document.addEventListener('visibilitychange', evaluate);
  window.addEventListener('lakomics-pause',pause);
  window.addEventListener('pointerdown', interaction, {passive:true});
  window.addEventListener('touchstart', interaction, {passive:true});
  window.addEventListener('keydown', interaction, {passive:true});
  window.addEventListener('wheel', interaction, {passive:true});
  window.addEventListener('scroll', interaction, {passive:true, capture:true});
  window.addEventListener(`${event}-toggle`, toggle);
  connection()?.addEventListener?.('change', evaluate);
  evaluate();
  return () => {
    stopped = true; halt();
    for (const name of options.wakeEvents ?? []) window.removeEventListener(name, interaction);
    removePower(); removeNetwork();
    removeVisible();
    document.removeEventListener('visibilitychange', evaluate);
    window.removeEventListener('lakomics-pause',pause);
    window.removeEventListener('pointerdown', interaction);
    window.removeEventListener('touchstart', interaction);
    window.removeEventListener('keydown', interaction);
    window.removeEventListener('wheel', interaction);
    window.removeEventListener('scroll', interaction, true);
    window.removeEventListener(`${event}-toggle`, toggle);
    connection()?.removeEventListener?.('change', evaluate);
  };
}
