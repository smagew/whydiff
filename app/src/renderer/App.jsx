import React, { useState } from 'react'
import ProjectList from './ProjectList.jsx'
import ProjectView from './ProjectView.jsx'

// Two screens: the project list, and a selected project (its git state → run a
// review). Kept as plain state — no router needed for two views.
export default function App() {
  const [selected, setSelected] = useState(null)
  return (
    <div className="wrap">
      {selected
        ? <ProjectView project={selected} onBack={() => setSelected(null)} />
        : <ProjectList onOpen={setSelected} />}
    </div>
  )
}
