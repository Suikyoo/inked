import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/spectral/500-italic.css';
import '@fontsource/spectral/600-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/auth.css';
import './styles/shell.css';
import './styles/home.css';
import './styles/map.css';
import './styles/note.css';
import './styles/settings.css';
import { App } from './App';
import { AppStore } from './state/store';
import { SemanticStore } from './semantic/semanticStore';

const store = new AppStore();
const semantic = new SemanticStore(store);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} semantic={semantic} />
  </StrictMode>,
);
