import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main>
      <h1>Page not found</h1>
      <p>
        The page you asked for does not exist. <Link to="/workspaces">Back to workspaces</Link>
      </p>
    </main>
  );
}
