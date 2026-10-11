import { createBrowserRouter, Outlet } from 'react-router-dom';
import { AuthStoreProvider } from './auth/AuthStore';
import { RequireAuth } from './auth/RequireAuth';
import { RequireGuest } from './auth/RequireGuest';
import { AppShell } from './components/AppShell';
import { AuthPage } from './pages/AuthPage';
import { HomeRedirect } from './pages/HomeRedirect';
import { NotFoundPage } from './pages/NotFoundPage';
import { SubscriberDetailPage } from './pages/SubscriberDetailPage';
import { WorkspaceListPage } from './pages/WorkspaceListPage';
import { WorkspaceOverviewPage } from './pages/WorkspaceOverviewPage';

// AuthStore lives above every route so login/logout and the single 401 handler
// can navigate; each group then adds its own guard (BUILD_PLAN §5.1).
export const router = createBrowserRouter([
  {
    element: (
      <AuthStoreProvider>
        <Outlet />
      </AuthStoreProvider>
    ),
    children: [
      {
        path: '/login',
        element: (
          <RequireGuest>
            <AuthPage mode="login" />
          </RequireGuest>
        ),
      },
      {
        path: '/register',
        element: (
          <RequireGuest>
            <AuthPage mode="register" />
          </RequireGuest>
        ),
      },
      {
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          { path: '/', element: <HomeRedirect /> },
          { path: '/workspaces', element: <WorkspaceListPage /> },
          { path: '/w/:workspaceId', element: <WorkspaceOverviewPage /> },
          {
            path: '/w/:workspaceId/subscribers/:subscriberId',
            element: <SubscriberDetailPage />,
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
