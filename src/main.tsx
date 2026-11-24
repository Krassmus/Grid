import { createRoot } from 'react-dom/client'
import { App } from './App'
import './theme.css'
import './styles.css'
import { initTheme } from './theme'
import { initLanguage } from './i18n'

initTheme()
initLanguage()

createRoot(document.getElementById('root')!).render(<App />)
