import { createRoot } from 'react-dom/client';
import { Phosphor } from './Phosphor';

// Later: <Phosphor selectedAssetUrls={selectedAssets.map(asset => asset.url)} onExit={closeGame} />
createRoot(document.getElementById('root')!).render(<Phosphor />);
