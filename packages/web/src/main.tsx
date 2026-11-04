import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// 首次使用：没有令牌则进入引导页
createRoot(document.getElementById('root')!).render(<App />);
