import {createRoot} from 'react-dom/client';
// Shared foundation first (tokens, controls, tablet overrides): screen stylesheets imported by
// App come after it, so a screen rule wins over a shared rule of equal specificity, as on the PC.
import './mobile.css';
import {App} from './App';
import {setDevelopmentTransport} from './transport';
async function start() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    const {demoTransport} = await import('./preview'); setDevelopmentTransport(demoTransport);
  }
  createRoot(document.getElementById('root')!).render(<App/>);
}
void start();
