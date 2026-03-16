import { Suspense, lazy } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'

const StudioPage = lazy(async () => {
  const module = await import('./pages/StudioPage')
  return { default: module.StudioPage }
})

const AdminPage = lazy(async () => {
  const module = await import('./pages/AdminPage')
  return { default: module.AdminPage }
})

function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-badge">Kids Collage Lab</span>
          <h1>Gesichter bauen mit Schnipseln</h1>
        </div>
        <nav className="topnav" aria-label="Navigation">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            Studio
          </NavLink>
          <NavLink to="/admin" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            Admin
          </NavLink>
        </nav>
      </header>

      <Suspense fallback={<div className="route-loading">Lade Ansicht...</div>}>
        <Routes>
          <Route path="/" element={<StudioPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </div>
  )
}

export default App
