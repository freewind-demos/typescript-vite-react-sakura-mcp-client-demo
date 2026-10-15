import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// sakura.css 是 classless 主题：只按标签排版，页面里不需要写任何类名
import "sakura.css/css/sakura.css";
// 本项目自己的少量样式覆盖，放在 sakura.css 之后才生效
import "./app.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
