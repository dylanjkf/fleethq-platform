import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ErrorState } from '@/components/ui/EmptyState';
import { useAuth } from '@/hooks/useAuth';
import { ApiClientError } from '@/api/client';

export function LoginPage() {
  const { login, verifyMfa } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setIsSubmitting(true);
    try {
      const result = await login(username, password);
      if (result.status === 'authenticated') {
        navigate('/', { replace: true });
      } else {
        setMfaToken(result.mfaToken);
      }
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'Could not sign in. Check your connection.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    if (!mfaToken) return;
    setFormError(null);
    setIsSubmitting(true);
    try {
      const result = await verifyMfa(mfaToken, code, rememberDevice);
      if (result.status === 'authenticated') {
        navigate('/', { replace: true });
      }
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'Could not verify that code.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold">FleetHQ Admin</h1>
        <p className="mb-8 text-sm text-(--text-secondary)">{mfaToken ? 'Enter your authenticator code' : 'Sign in to the internal admin platform'}</p>

        {!mfaToken ? (
          <form onSubmit={handleLogin} className="space-y-3" autoFocus>
            <Input placeholder="Username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
            <Input
              placeholder="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-3">
            <Input placeholder="6-digit code or backup code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
            <label className="flex items-center gap-2 text-sm text-(--text-secondary)">
              <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
              Remember this device for 30 days
            </label>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Verifying…' : 'Verify'}
            </Button>
          </form>
        )}

        {formError && <div className="mt-4"><ErrorState message={formError} /></div>}
      </div>
    </div>
  );
}
