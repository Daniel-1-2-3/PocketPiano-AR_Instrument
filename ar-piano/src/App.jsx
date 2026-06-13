import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Render from "./pages/Render.jsx";
import Calibrate from "./pages/Calibrate.jsx";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Render />} />
        <Route path="/calibrate" element={<Calibrate />} />
      </Routes> 
    </BrowserRouter>
  );
}

export default App;