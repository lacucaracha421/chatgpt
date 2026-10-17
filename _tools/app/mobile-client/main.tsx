import {observeStartupSplash} from './startupPerf';
import {createRoot} from 'react-dom/client';
// Shared foundation first (tokens, controls, tablet overrides): screen stylesheets imported by
// App come after it, so a screen rule wins over a shared rule of equal specificity, as on the PC.
import './mobile.css';
import {App} from './App';
import {setDevelopmentTransport} from './transport';
import {LaunchSplash} from '../src/shared/launch/LaunchSplash';
// The focus ring is for a hardware keyboard. Touch and programmatic focus (a sheet opening, a
// search field) would otherwise draw it as a stray blue line (mobile.css hides it unless keyboard).
addEventListener('keydown', event => { if (event.key === 'Tab' || event.key.startsWith('Arrow')) document.documentElement.dataset.input = 'keyboard'; }, true);
addEventListener('pointerdown', () => { delete document.documentElement.dataset.input; }, true);
async function start() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    const {demoTransport} = await import('./preview'); setDevelopmentTransport(demoTransport);
  }
  // The launch splash from index.html stays until Home (or the connection screen) is ready.
  observeStartupSplash();
  createRoot(document.getElementById('root')!).render(<><App/><LaunchSplash/></>);
}
void start();
