import { clsx } from 'clsx';
import { useEffect, type ReactNode } from 'react';

export function Spinner({
  label,
  inline = false,
}: {
  label?: string;
  inline?: boolean;
}) {
  if (inline) {
    return (
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600 align-[-2px]" />
    );
  }
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-slate-500">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
          {actions}
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-base font-medium text-slate-700">{title}</p>
      {description && (
        <p className="max-w-md text-sm text-slate-500">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Alert({
  variant = 'info',
  children,
}: {
  variant?: 'info' | 'success' | 'error' | 'warning';
  children: ReactNode;
}) {
  const map = {
    info: 'bg-brand-50 text-brand-800 border-brand-200',
    success: 'bg-green-50 text-green-800 border-green-200',
    error: 'bg-red-50 text-red-800 border-red-200',
    warning: 'bg-amber-50 text-amber-800 border-amber-200',
  };
  return (
    <div className={clsx('rounded-md border px-4 py-3 text-sm', map[variant])}>
      {children}
    </div>
  );
}

/** Simple centered modal with backdrop. Escape / backdrop click closes. */
export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={clsx(
          'relative z-10 w-full rounded-xl border border-slate-200 bg-white shadow-xl',
          wide ? 'max-w-2xl' : 'max-w-lg',
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 id="modal-title" className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-sm text-slate-500">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="btn-ghost shrink-0 px-2 py-1 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="max-h-[min(70vh,560px)] overflow-y-auto px-5 py-4">
          {children}
        </div>
      </div>
    </div>
  );
}
