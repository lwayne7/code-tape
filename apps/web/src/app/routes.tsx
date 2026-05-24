import { createBrowserRouter } from "react-router-dom";
import { AppShell } from "./AppShell";
import { RecordingLibraryPage } from "@/features/library/RecordingLibraryPage";
import { RecorderPage } from "@/features/recorder/RecorderPage";
import { ReplayPage } from "@/features/player/ReplayPage";
import { NotFoundPage } from "./NotFoundPage";
import { routerBasename } from "./routerBase";

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <AppShell />,
      children: [
        { index: true, element: <RecordingLibraryPage /> },
        { path: "record", element: <RecorderPage /> },
        { path: "replay/:id", element: <ReplayPage /> },
        { path: "*", element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: routerBasename },
);
