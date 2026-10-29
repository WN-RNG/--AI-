/**
 * 前端启动入口：挂载 React 根组件，并加载全站样式。
 * 逐文件说明见项目根目录《项目结构与代码说明.md》。
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
