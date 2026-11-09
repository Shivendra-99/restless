import { createRoot } from 'react-dom/client';
import { App } from '@probe/ui';
import { extensionBridge } from './bridge';

createRoot(document.getElementById('root')!).render(<App bridge={extensionBridge} />);
