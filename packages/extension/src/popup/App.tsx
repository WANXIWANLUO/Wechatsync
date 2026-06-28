import { HashRouter, Routes, Route } from 'react-router-dom'
import { HomeNew } from './pages/HomeNew'
import { AddCMSPage } from './pages/AddCMS'
import { HistoryPage } from './pages/History'
import { DisplayListPage } from './pages/DisplayList'
import { AboutPage } from './pages/About'
import { AccountListPage } from './pages/AccountList'

export default function App() {
  return (
    <HashRouter>
      <div className="flex flex-col h-full min-h-[500px]">
        <Routes>
          <Route path="/" element={<HomeNew />} />
          <Route path="/account-list" element={<AccountListPage />} />
          <Route path="/add-cms" element={<AddCMSPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/display-list" element={<DisplayListPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </div>
    </HashRouter>
  )
}
