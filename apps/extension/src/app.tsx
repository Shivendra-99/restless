import { createRoot } from 'react-dom/client';
import { App } from '@restless/ui';
import { extensionBridge } from './bridge';

createRoot(document.getElementById('root')!).render(<App bridge={extensionBridge} />);
