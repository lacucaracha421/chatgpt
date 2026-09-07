import {createRoot} from 'react-dom/client';
import {App} from './App';
import {setDevelopmentTransport} from './transport';
import './mobile.css';
async function start() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    const {demoTransport} = await import('./preview'); setDevelopmentTransport(demoTransport);
  }
  createRoot(document.getElementById('root')!).render(<App/>);
}
void start();
