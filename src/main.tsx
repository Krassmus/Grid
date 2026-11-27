import { createRoot } from 'react-dom/client'
import { App } from './App'
import './theme.css'
import './styles.css'
import { initTheme } from './theme'
import { initZoom } from './zoom'
import { initScrollLock } from './scrollLock'
import { initLanguage } from './i18n'

initTheme()
initZoom()
initScrollLock()
initLanguage()

createRoot(document.getElementById('root')!).render(<App />)
