import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-10 w-full rounded-lg border border-(--border-subtle) bg-(--surface-1) px-3 text-sm text-(--text-primary) outline-none placeholder:text-(--text-tertiary) focus:border-accent-500 ${className}`}
      {...props}
    />
  );
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-lg border border-(--border-subtle) bg-(--surface-1) px-3 py-2 text-sm text-(--text-primary) outline-none placeholder:text-(--text-tertiary) focus:border-accent-500 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = '', ...props }: import('react').SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-10 w-full rounded-lg border border-(--border-subtle) bg-(--surface-1) px-3 text-sm text-(--text-primary) outline-none focus:border-accent-500 ${className}`}
      {...props}
    />
  );
}
