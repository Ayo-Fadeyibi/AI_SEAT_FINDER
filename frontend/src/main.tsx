
  import { createRoot } from "react-dom/client";
  import { BrowserRouter, Routes, Route } from "react-router";
  import Landing from "./app/Landing.tsx";
  import App from "./app/App.tsx";
  import Admin from "./app/Admin.tsx";
  import Faq from "./app/Faq.tsx";
  import "./styles/index.css";

  createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/finder" element={<App />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/faq" element={<Faq />} />
      </Routes>
    </BrowserRouter>
  );
