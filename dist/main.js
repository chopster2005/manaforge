import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
ReactDOM.createRoot(document.getElementById('root')).render(_jsx(React.StrictMode, { children: _jsx(App, {}) }));
if ('serviceWorker' in navigator)
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
