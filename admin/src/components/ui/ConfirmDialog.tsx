import { useState } from 'react';
import { Button } from './Button';
import { Textarea } from './Input';

interface ConfirmDialogProps {
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the dialog collects free text (e.g. a suspend reason) before confirming. */
  requireReason?: boolean;
  onConfirm: (reason?: string) => void | Promise<void>;
  onCancel: () => void;
}

/** A plain, dependency-free modal overlay — used for every destructive/consequential admin action's confirmation. */
export function ConfirmDialog({ title, description, confirmLabel = 'Confirm', danger, requireReason, onConfirm, onCancel }: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleConfirm() {
    setIsSubmitting(true);
    try {
      await onConfirm(requireReason ? reason : undefined);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-(--radius-panel) border border-(--border-subtle) bg-(--surface-1) p-5 shadow-(--elevation-1)" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-(--text-secondary)">{description}</p>}
        {requireReason && (
          <Textarea
            className="mt-3"
            rows={3}
            placeholder="Reason…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            size="sm"
            onClick={handleConfirm}
            disabled={isSubmitting || (requireReason && !reason.trim())}
          >
            {isSubmitting ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
