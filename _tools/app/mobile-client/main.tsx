import {createRoot} from 'react-dom/client';
// Shared foundation first (tokens, controls, tablet overrides): screen stylesheets imported by
// App come after it, so a screen rule wins over a shared rule of equal specificity, as on the PC.
import './mobile.css';
import {App} from './App';
import {setDevelopmentTransport} from './transport';
import {LaunchSplash} from '../src/shared/launch/LaunchSplash';
async function start() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    const {demoTransport} = await import('./preview'); setDevelopmentTransport(demoTransport);
  }
  // The launch splash from index.html stays until Home (or the connection screen) is ready.
  createRoot(document.getElementById('root')!).render(<><App/><LaunchSplash/></>);
}
void start();
