import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ToastContainer } from './lib/toast'
import './styles.css'

// Honor saved theme preference early to avoid a flash
try {
  const theme = localStorage.getItem('gemma-chat:theme') // 'light' | 'dark' | 'system'
  const resolved =
    theme === 'light' || theme === 'dark'
      ? theme
      : window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
  document.documentElement.dataset.theme = resolved
} catch {
  document.documentElement.dataset.theme = 'dark'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ToastContainer />
  </StrictMode>
)
