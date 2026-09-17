import {createRoot} from 'react-dom/client';
import {setDevelopmentTransport} from './transport';
import './mobile.css';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  if (import.meta.env.MODE === 'post-authority') {
    const {PostAuthorityPreview} = await import('./PostAuthorityPreview');
    root.render(<PostAuthorityPreview/>);
    return;
  }
  const {App} = await import('./App');
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    const {demoTransport} = await import('./preview');
    setDevelopmentTransport(demoTransport);
  }
  root.render(<App/>);
}
void start();
