import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Calibrate from "./pages/Calibrate.jsx";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Calibrate />} />
      </Routes> 
    </BrowserRouter>
  );
}

export default App;