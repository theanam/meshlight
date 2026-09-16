import './styles/app.css'
import { mountApp } from './ui/app'

mountApp(document.querySelector<HTMLElement>('#app')!)

// Register the offline cache (spec §5.6). Failure is non-fatal: the app runs
// perfectly well online, it just will not survive a reload without network.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
  })
}
