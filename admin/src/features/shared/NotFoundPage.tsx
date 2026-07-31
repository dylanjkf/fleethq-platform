import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <p className="text-lg font-semibold">Page not found</p>
      <Link to="/" className="text-sm text-accent-400 hover:underline">
        Back to dashboard
      </Link>
    </div>
  );
}
