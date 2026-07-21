import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// The generated API client issues root-relative "/api/..." requests. Under a subpath deploy
// (e.g. BASE_URL="/ikio-tds-generator/") those must be prefixed with the subpath — exactly like
// apiUrl() already does for the hand-written fetches — or GETs like useGetExtraction hit the domain
// root and 404. For root hosting BASE_URL is "/", which becomes "" here (no prefix, unchanged).
setBaseUrl(import.meta.env.BASE_URL.replace(/\/$/, ""));

createRoot(document.getElementById("root")!).render(<App />);
